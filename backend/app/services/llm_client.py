"""Unified LLM client with a resilient multi-provider fallback chain.

Order of preference (any provider without a configured key is skipped):

    Groq  ->  Gemini  ->  OpenRouter  ->  Cerebras

Groq and Cerebras share a generous free tier and are very fast, so a single
provider being rate-limited (HTTP 429) or briefly erroring no longer collapses
the screener / Ask-AI answers into a canned heuristic response: the next
provider in the chain is tried automatically.

Gemini, OpenRouter, and Cerebras are all called over plain REST (OpenAI-style
for the latter two) so no extra pip dependency is required. Groq keeps using its
official SDK because it is already a project dependency.
"""

import os

import requests

_groq_client = None

DEFAULT_GROQ_CHAT_MODEL = "openai/gpt-oss-120b"
DEFAULT_GROQ_FAST_MODEL = "openai/gpt-oss-20b"
GROQ_MODEL_FALLBACKS = ("openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b")


def is_reasoning_model(model: str | None) -> bool:
    return bool(model) and "gpt-oss" in str(model)

# Providers we know how to call, in default preference order.
_PROVIDER_ORDER = ["groq", "gemini", "openrouter", "cerebras"]


def _env_key(name: str) -> str | None:
    """Return a non-empty env value, treating obvious placeholders as unset.

    Guards against half-filled keys such as a Gemini key that still has
    ``your_gemini_key`` pasted on the end.
    """
    value = (os.getenv(name) or "").strip()
    if not value:
        return None
    lowered = value.lower()
    if "your_" in lowered or lowered in {"changeme", "todo", "xxx"}:
        return None
    return value


def _get_groq():
    global _groq_client
    if _groq_client is None:
        api_key = _env_key("GROQ_API_KEY")
        if not api_key:
            return None
        from groq import Groq

        # No SDK retries: a 429 here is usually the daily token cap, and the
        # retry backoff only delayed the switch to the next model by ~15s.
        _groq_client = Groq(api_key=api_key, max_retries=0)
    return _groq_client


def groq_available() -> bool:
    return _env_key("GROQ_API_KEY") is not None


def gemini_available() -> bool:
    return _env_key("GEMINI_API_KEY") is not None


def openrouter_available() -> bool:
    return _env_key("OPENROUTER_API_KEY") is not None


def cerebras_available() -> bool:
    return _env_key("CEREBRAS_API_KEY") is not None


def _provider_available(provider: str) -> bool:
    return {
        "groq": groq_available,
        "gemini": gemini_available,
        "openrouter": openrouter_available,
        "cerebras": cerebras_available,
    }.get(provider, lambda: False)()


def _groq_chat(messages, temperature: float, max_tokens: int, model: str | None) -> str:
    client = _get_groq()
    if client is None:
        raise RuntimeError("GROQ_API_KEY is not set.")
    # Groq retired its Llama 3 models in 2026; gpt-oss-120b is the current
    # general-purpose model on the account. Override with GROQ_CHAT_MODEL.
    model = model or os.getenv("GROQ_CHAT_MODEL", DEFAULT_GROQ_CHAT_MODEL)
    # Each Groq model has its own daily token quota, so when one is rate
    # limited (429) or retired (404) the next model on the account still works.
    candidates = [model] + [m for m in GROQ_MODEL_FALLBACKS if m != model]
    last_exc: Exception | None = None
    for candidate in candidates:
        try:
            return _groq_complete(client, messages, temperature, max_tokens, candidate)
        except Exception as exc:  # noqa: BLE001
            status = getattr(exc, "status_code", None)
            # A bad request (400/401) fails the same on every model; rate
            # limits, retired models, server errors and dropped connections
            # (no status) are worth one try on the next model.
            if status is not None and status not in (404, 429, 500, 502, 503):
                raise
            print(f"[LLM] groq {candidate} unavailable ({status}), trying next Groq model")
            last_exc = exc
    raise last_exc or RuntimeError("no Groq model available.")


def _groq_complete(client, messages, temperature: float, max_tokens: int, model: str) -> str:
    extra: dict = {}
    if is_reasoning_model(model):
        # gpt-oss reasons before answering and those tokens count against the
        # completion budget; keep reasoning short and leave room for the reply.
        extra = {"extra_body": {"reasoning_effort": "low"}}
        max_tokens = max_tokens + 600
    completion = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        **extra,
    )
    return (completion.choices[0].message.content or "").strip()


def _openai_compatible_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages,
    temperature: float,
    max_tokens: int,
    extra_headers: dict | None = None,
) -> str:
    """Call any OpenAI-compatible /chat/completions endpoint (OpenRouter, Cerebras)."""
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    response = requests.post(
        base_url.rstrip("/") + "/chat/completions",
        headers=headers,
        json={
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
        timeout=40,
    )
    response.raise_for_status()
    payload = response.json()
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("provider returned no choices.")
    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("provider returned an empty response.")
    return text


def _openrouter_chat(messages, temperature: float, max_tokens: int, model: str | None) -> str:
    api_key = _env_key("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set.")
    model = model or os.getenv("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct")
    return _openai_compatible_chat(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        # Optional attribution headers OpenRouter recommends; harmless if unset.
        extra_headers={
            "HTTP-Referer": os.getenv("OPENROUTER_REFERER", "https://bullseye.help"),
            "X-Title": os.getenv("OPENROUTER_TITLE", "Bullseye"),
        },
    )


def _cerebras_chat(messages, temperature: float, max_tokens: int, model: str | None) -> str:
    api_key = _env_key("CEREBRAS_API_KEY")
    if not api_key:
        raise RuntimeError("CEREBRAS_API_KEY is not set.")
    model = model or os.getenv("CEREBRAS_MODEL", "llama-3.3-70b")
    return _openai_compatible_chat(
        base_url="https://api.cerebras.ai/v1",
        api_key=api_key,
        model=model,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
    )


def _gemini_chat(messages, temperature: float, max_tokens: int) -> str:
    api_key = _env_key("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set.")
    model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

    system_chunks: list[str] = []
    contents: list[dict] = []
    for message in messages:
        role = message.get("role")
        text = message.get("content") or ""
        if role == "system":
            system_chunks.append(text)
            continue
        contents.append(
            {
                "role": "model" if role == "assistant" else "user",
                "parts": [{"text": text}],
            }
        )

    body: dict = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        },
    }
    if system_chunks:
        body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_chunks)}]}

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    )
    response = requests.post(
        url,
        params={"key": api_key},
        json=body,
        timeout=40,
    )
    response.raise_for_status()
    payload = response.json()
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates.")
    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts).strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


def _call_provider(provider: str, messages, temperature: float, max_tokens: int, model: str | None) -> str:
    if provider == "groq":
        return _groq_chat(messages, temperature, max_tokens, model)
    if provider == "gemini":
        return _gemini_chat(messages, temperature, max_tokens)
    if provider == "openrouter":
        return _openrouter_chat(messages, temperature, max_tokens, model)
    if provider == "cerebras":
        return _cerebras_chat(messages, temperature, max_tokens, model)
    raise RuntimeError(f"unknown provider: {provider}")


def chat(
    messages: list[dict],
    *,
    temperature: float = 0.3,
    max_tokens: int = 1200,
    model: str | None = None,
    prefer: str = "groq",
) -> dict:
    """Return {"text": str, "model": <provider>}.

    Tries the preferred provider first, then walks the rest of the chain,
    skipping any provider without a configured key. Raises RuntimeError only
    when every available provider fails.
    """
    order = [prefer] + [p for p in _PROVIDER_ORDER if p != prefer]
    # A per-call ``model`` override only makes sense for the preferred provider;
    # downstream fallbacks use their own configured default model.
    errors: list[str] = []
    attempted = False
    for index, provider in enumerate(order):
        if not _provider_available(provider):
            continue
        attempted = True
        provider_model = model if index == 0 else None
        try:
            text = _call_provider(provider, messages, temperature, max_tokens, provider_model)
            return {"text": text, "model": provider}
        except Exception as exc:  # noqa: BLE001 - we want to try the next provider
            errors.append(f"{provider}: {exc}")
            print(f"[LLM] {provider} failed, trying next provider: {exc}")
            continue
    if not attempted:
        raise RuntimeError("No LLM provider configured. Set GROQ_API_KEY (and ideally a fallback key).")
    raise RuntimeError("All LLM providers failed. " + " | ".join(errors))


def any_provider_available() -> bool:
    return any(_provider_available(p) for p in _PROVIDER_ORDER)


def configured_providers() -> list[str]:
    """List providers that currently have a usable key (for diagnostics/logging)."""
    return [p for p in _PROVIDER_ORDER if _provider_available(p)]
