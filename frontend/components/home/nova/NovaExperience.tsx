"use client";

// The Nova homepage hero: a fixed WebGL particle scene (portaled to <body>) that
// morphs through five formations as the reader scrolls five acts of copy.
//  • Copy is SSR'd and readable with WebGL off or JS off.
//  • Lenis smooths the wheel; native scroll position is still the source of
//    truth, so nothing else on the page has to know about it.
//  • Scroll work is one rAF-throttled read per frame; the scene only receives a
//    number. Aurora colour washes cross-fade with opacity (compositor only).
//  • Reduced-motion or weak devices get the aurora and the copy, no WebGL.

import Link from "next/link";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { NovaScene } from "./NovaScene";

type SceneLike = Pick<NovaScene, "setMorph" | "setPointer" | "setOpacity" | "resize" | "start" | "stop" | "dispose">;

const noopSubscribe = () => () => {};

/**
 * Particle budget by GPU class. Soft glowing points don't need hi-DPI, and
 * fill rate (count × point area × pixel ratio²) is what integrated laptop
 * GPUs run out of first, so the budget is set by the graphics chip, not RAM.
 */
function pickTier(): { count: number; maxDpr: number } {
  const phone = window.innerWidth < 768 || window.matchMedia("(pointer: coarse)").matches;
  let renderer = "";
  let software = false;
  try {
    const probe = document.createElement("canvas");
    // null here means the browser would fall back to software rendering.
    software = !probe.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  } catch {
    software = true;
  }
  if (software || /swiftshader|llvmpipe|basic render/i.test(renderer)) return { count: 4000, maxDpr: 1 };
  if (phone) return { count: 7000, maxDpr: 1 };
  if (/intel|uhd|iris|mali|adreno|powervr/i.test(renderer)) return { count: 11000, maxDpr: 1 };
  return { count: 16000, maxDpr: 1.25 };
}

function actsIn(root: HTMLElement | null) {
  return Array.from(root?.querySelectorAll<HTMLElement>("[data-nova-act]") ?? []);
}

interface NovaExperienceProps {
  signedIn: boolean;
  onOpenDailySignals: () => void;
  /** Live stock cards shown in the landing viewport, under the headline. */
  stockStrip?: ReactNode;
}

const STOP_LABELS = ["Start", "The market", "The read", "The verdict", "Your move"];

// Each formation has its own colour wash behind the particles.
const AURORAS = [
  "radial-gradient(55% 60% at 72% 40%, rgba(139,92,246,0.42), transparent 70%), radial-gradient(45% 50% at 20% 85%, rgba(255,46,151,0.28), transparent 70%)",
  "radial-gradient(55% 55% at 50% 58%, rgba(0,229,255,0.30), transparent 70%), radial-gradient(50% 50% at 85% 15%, rgba(139,92,246,0.35), transparent 70%)",
  "radial-gradient(60% 50% at 30% 70%, rgba(255,46,151,0.34), transparent 70%), radial-gradient(45% 45% at 80% 30%, rgba(255,181,71,0.24), transparent 70%)",
  "radial-gradient(50% 55% at 50% 40%, rgba(255,46,151,0.30), transparent 70%), radial-gradient(40% 45% at 15% 20%, rgba(0,229,255,0.24), transparent 70%)",
  "radial-gradient(55% 55% at 35% 50%, rgba(184,255,60,0.20), transparent 70%), radial-gradient(50% 50% at 80% 70%, rgba(0,229,255,0.28), transparent 70%)",
];

function Eyebrow({ index, label, align = "left" }: { index: string; label: string; align?: "left" | "right" | "center" }) {
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <div className={`flex items-center gap-3 ${justify}`}>
      <span className="nova-dot" aria-hidden />
      <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[#cfc9ea]">
        <span className="text-paper">{index}</span>
        <span className="mx-2 opacity-50">/</span>
        {label}
      </span>
    </div>
  );
}

function Chips({ items, align = "left" }: { items: string[]; align?: "left" | "right" | "center" }) {
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";
  return (
    <div className={`mt-7 flex flex-wrap gap-2 ${justify}`}>
      {items.map((item) => (
        <span key={item} className="nova-chip">
          {item}
        </span>
      ))}
    </div>
  );
}

function Act({
  align,
  children,
}: {
  align: "left" | "right" | "top" | "bottom";
  children: ReactNode;
}) {
  const vertical =
    align === "top" ? "items-start pt-[16vh]" : align === "bottom" ? "items-end pb-[14vh]" : "items-center";
  const horizontal =
    align === "right"
      ? "justify-center text-center md:justify-end md:text-right"
      : align === "left"
        ? "justify-center text-center md:justify-start md:text-left"
        : "justify-center text-center";
  return (
    <section data-nova-act className="relative min-h-[170svh] w-full">
      {/* Sticky copy holds still while the particles re-form behind it. */}
      <div className={`sticky top-0 flex h-[100svh] w-full px-5 sm:px-10 lg:px-16 ${vertical} ${horizontal}`}>
        <div data-nova-reveal className="nova-scrim max-w-[40rem] px-2 py-6">
          {children}
        </div>
      </div>
    </section>
  );
}

export function NovaExperience({ signedIn, onOpenDailySignals, stockStrip }: NovaExperienceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const auroraRefs = useRef<Array<HTMLDivElement | null>>([]);
  const sceneRef = useRef<SceneLike | null>(null);
  const lenisRef = useRef<{ scrollTo: (target: number | HTMLElement, opts?: Record<string, unknown>) => void } | null>(null);

  // True only on the client, so the portal never renders during SSR.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // WebGL when the browser offers it; otherwise the Canvas 2D fallback, so the
  // particles show even with hardware acceleration switched off.
  const [mode, setMode] = useState<"webgl" | "2d" | null>(null);
  const [active, setActive] = useState(0);

  // Reduced motion does NOT hide the scene (Windows turns it on whenever
  // "Animation effects" is off); it only freezes the idle drift and makes
  // shape changes instant.
  useEffect(() => {
    let webgl = false;
    try {
      const c = document.createElement("canvas");
      webgl = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
    // ?scene=2d forces the fallback, for checking it on a machine with WebGL.
    if (new URLSearchParams(window.location.search).get("scene") === "2d") webgl = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot client capability probe
    setMode(webgl ? "webgl" : "2d");
  }, []);

  // Smooth wheel scrolling for the homepage only.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let destroyed = false;
    let instance: { destroy: () => void } | null = null;
    import("lenis").then(({ default: Lenis }) => {
      if (destroyed) return;
      const lenis = new Lenis({
        lerp: 0.12,
        smoothWheel: true,
        autoRaf: true,
        allowNestedScroll: true,
        prevent: (node: HTMLElement) => !!node.closest?.("[data-lenis-prevent]"),
      });
      instance = lenis;
      lenisRef.current = lenis as unknown as typeof lenisRef.current;
    });
    return () => {
      destroyed = true;
      instance?.destroy();
      lenisRef.current = null;
    };
  }, []);

  // Build the scene for the chosen renderer.
  useEffect(() => {
    if (!mode || !mounted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup = () => {};

    const load = mode === "webgl" ? import("./NovaScene") : import("./NovaScene2D");
    load.then((mod) => {
      if (disposed) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let scene: SceneLike;
      try {
        if ("NovaScene" in mod) {
          const { count, maxDpr } = pickTier();
          scene = new mod.NovaScene({ canvas, count, maxDpr, still });
        } else {
          const phone = window.innerWidth < 768;
          scene = new mod.NovaScene2D({ canvas, count: phone ? 1400 : 2600, still });
        }
      } catch {
        // WebGL context creation can still fail after the probe; fall back.
        if (mode === "webgl") setMode("2d");
        return;
      }
      sceneRef.current = scene;
      const resize = () => scene.resize(window.innerWidth, window.innerHeight);
      resize();
      scene.start();
      canvas.dataset.ready = "true";
      // Sync to the current scroll position (e.g. a reload halfway down).
      window.dispatchEvent(new Event("scroll"));

      const onPointer = (e: PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        scene.setPointer((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
      };
      const onVisibility = () => (document.hidden ? scene.stop() : scene.start());
      window.addEventListener("resize", resize);
      window.addEventListener("pointermove", onPointer, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);
      cleanup = () => {
        window.removeEventListener("resize", resize);
        window.removeEventListener("pointermove", onPointer);
        document.removeEventListener("visibilitychange", onVisibility);
        scene.dispose();
        sceneRef.current = null;
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [mode, mounted]);

  // Scroll → morph value, aurora mix, scene fade, rail state. One read per frame.
  useEffect(() => {
    if (!mounted) return;
    let frame = 0;
    let lastActive = -1;
    let starts: number[] = [];
    let rootBottom = 0;

    const measure = () => {
      const y = window.scrollY;
      starts = actsIn(rootRef.current).map((el) => el.getBoundingClientRect().top + y);
      const root = rootRef.current;
      rootBottom = root ? root.getBoundingClientRect().bottom + y : 0;
    };

    const update = () => {
      frame = 0;
      const vh = window.innerHeight || 1;
      const y = window.scrollY;
      // Hop i happens while act i rises from 70% down the screen to 10% past the top.
      let morph = 0;
      starts.forEach((top) => {
        morph += Math.min(1, Math.max(0, (y - (top - vh * 0.7)) / (vh * 0.8)));
      });
      sceneRef.current?.setMorph(morph);

      AURORAS.forEach((_, i) => {
        const el = auroraRefs.current[i];
        if (el) el.style.opacity = String(Math.max(0, 1 - Math.abs(morph - i)));
      });

      // Once the last act has scrolled away, fade the particles out and stop rendering.
      const fade = Math.min(1, Math.max(0, (y + vh - rootBottom) / (vh * 0.8)));
      const opacity = 1 - fade;
      if (canvasWrapRef.current) canvasWrapRef.current.style.opacity = String(opacity);
      sceneRef.current?.setOpacity(opacity);

      const idx = Math.min(4, Math.round(morph));
      if (idx !== lastActive) {
        lastActive = idx;
        setActive(idx);
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onResize = () => {
      measure();
      onScroll();
    };

    measure();
    update();
    // Fonts and live cards can shift layout after first paint.
    const ro = new ResizeObserver(onResize);
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [mounted, mode]);

  // Copy reveals as each act arrives. Content stays visible without JS.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.classList.add("nova-js");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) el.dataset.in = "true";
          else delete el.dataset.in;
        });
      },
      { threshold: 0.3 },
    );
    root.querySelectorAll("[data-nova-reveal]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const goTo = (i: number) => {
    const target = i === 0 ? 0 : actsIn(rootRef.current)[i - 1];
    if (target == null) return;
    const lenis = lenisRef.current;
    if (lenis) {
      lenis.scrollTo(target, { duration: 1.6 });
    } else if (typeof target === "number") {
      window.scrollTo({ top: target, behavior: "smooth" });
    } else {
      target.scrollIntoView({ behavior: "smooth" });
    }
  };

  const fixedLayer = (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#070514]">
      {AURORAS.map((bg, i) => (
        <div
          key={i}
          ref={(el) => {
            auroraRefs.current[i] = el;
          }}
          className="nova-aurora absolute -inset-[10%]"
          style={{ background: bg, opacity: i === 0 ? 1 : 0 }}
        />
      ))}
      <div ref={canvasWrapRef} className="absolute inset-0">
        {mode ? (
          // Keyed by renderer: a canvas that tried WebGL can't switch to 2D.
          <canvas key={mode} ref={canvasRef} className="nova-canvas absolute inset-0 h-full w-full" />
        ) : null}
      </div>
      <div className="nova-vignette absolute inset-0" />
    </div>
  );

  return (
    <>
      {mounted && createPortal(fixedLayer, document.body)}

      {/* Progress rail: where you are in the flight, and a shortcut to each stop. */}
      <nav
        aria-label="Homepage sections"
        className="fixed right-4 top-1/2 z-40 hidden -translate-y-1/2 flex-col gap-3 lg:flex"
      >
        {STOP_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => goTo(i)}
            aria-current={active === i ? "step" : undefined}
            className="nova-rail-btn group"
          >
            <span className="nova-rail-label">{label}</span>
            <span className="nova-rail-dot" data-active={active === i ? "true" : undefined} />
          </button>
        ))}
      </nav>

      <div ref={rootRef} className="relative z-10">
        {/* ── LANDING ── */}
        <section className="relative flex min-h-[calc(100svh-7rem)] w-full flex-col justify-between gap-10 px-5 pb-8 pt-[4vh] sm:px-10 lg:px-16">
          <div data-nova-reveal data-in="true" className="nova-scrim max-w-[40rem]">
            <Eyebrow index="NSE" label="Live market intelligence" />
            <h1 className="mt-6 font-display text-[clamp(3rem,8vw,7.2rem)] font-normal leading-[0.9] text-paper">
              One honest
              <br />
              <em className="nova-gradient-text italic">verdict.</em>
            </h1>
            <p className="mt-6 max-w-[46ch] font-body text-[16px] leading-7 text-[#d6d0f0]">
              Bullseye reads the whole market every evening and hands you the short list: entry,
              target, stop, and an honest conviction score.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/screens" className="nova-btn nova-btn-primary group">
                Open Screener
                <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
                  →
                </span>
              </Link>
              <Link href="/ask-ai" className="nova-btn nova-btn-ghost">
                Ask AI
              </Link>
            </div>
            <div className="nova-scroll-cue mt-10 hidden items-center gap-3 sm:flex">
              <span className="nova-scroll-line" aria-hidden />
              <span className="font-numeric text-[11px] uppercase tracking-[0.28em] text-[#cfc9ea]">
                Scroll to fly through the market
              </span>
            </div>
          </div>

          {stockStrip ? <div className="w-full">{stockStrip}</div> : null}
        </section>

        <Act align="top">
          <Eyebrow index="01" label="The whole tape" align="center" />
          <h2 className="mt-6 font-display text-[clamp(2.6rem,6.4vw,5.4rem)] font-normal leading-[0.96] text-paper">
            The whole market,
            <br />
            <em className="nova-gradient-text italic">at once.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-[44ch] font-body text-[16px] leading-7 text-[#d6d0f0]">
            Two thousand NSE tickers, every session. Indices, sectors, the noise and the signal, all in
            view before a single decision is made.
          </p>
          <Chips align="center" items={["2,000+ tickers", "Every session", "Nifty · Sensex · sectors"]} />
        </Act>

        <Act align="right">
          <Eyebrow index="02" label="The read" align="right" />
          <h2 className="mt-6 font-display text-[clamp(2.6rem,6.4vw,5.4rem)] font-normal leading-[0.96] text-paper">
            We fly the tape
            <br />
            so <em className="nova-gradient-text italic">you don&apos;t.</em>
          </h2>
          <p className="ml-auto mt-6 max-w-[44ch] font-body text-[16px] leading-7 text-[#d6d0f0] max-md:mx-auto">
            The engine scores momentum, quality, risk and setup across the market, then throws away
            everything that doesn&apos;t clear the gates. Most days, most of it.
          </p>
          <Chips align="right" items={["Momentum", "Quality", "Risk", "Setup"]} />
        </Act>

        <Act align="bottom">
          <Eyebrow index="03" label="The verdict" align="center" />
          <h2 className="mt-6 font-display text-[clamp(2.6rem,6.4vw,5.4rem)] font-normal leading-[0.96] text-paper">
            Then it commits
            <br />
            to <em className="nova-gradient-text italic">one.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-[44ch] font-body text-[16px] leading-7 text-[#d6d0f0]">
            A verdict, stamped: buy or sell, entry and target, a stop, and the conviction behind it. On a
            weak day, it tells you to sit out.
          </p>
          <Chips align="center" items={["Entry", "Target", "Stop", "Conviction"]} />
        </Act>

        <Act align="right">
          <Eyebrow index="04" label="Your move" align="right" />
          <h2 className="mt-6 font-display text-[clamp(3rem,7.6vw,6.4rem)] font-normal leading-[0.92] text-paper">
            See your
            <br />
            <em className="nova-gradient-text italic">number.</em>
          </h2>
          <p className="ml-auto mt-6 max-w-[44ch] font-body text-[16px] leading-7 text-[#d6d0f0] max-md:mx-auto">
            Open the screener for today&apos;s ranked short list, or ask anything in plain English.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3 md:justify-end">
            <Link href="/screens" className="nova-btn nova-btn-primary group">
              Open Screener
              <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">
                →
              </span>
            </Link>
            <Link href="/ask-ai" className="nova-btn nova-btn-ghost">
              Ask AI
            </Link>
            <button type="button" onClick={onOpenDailySignals} className="nova-btn nova-btn-link">
              {signedIn ? "Daily alerts" : "Get daily signals"}
            </button>
          </div>
        </Act>
      </div>
    </>
  );
}

export default NovaExperience;
