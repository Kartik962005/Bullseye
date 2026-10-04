import os
import unittest
from unittest import mock

from app.services import llm_client
from app.services.relevance_guard import (
    GREETING_REPLY,
    OFF_TOPIC_REPLY,
    is_off_topic_marker,
    small_talk_reply,
)


class SmallTalkTests(unittest.TestCase):
    def test_greetings_get_the_greeting(self):
        for text in ["hi", "Hi!", "hello", "hey there", "hii", "good morning", "how are you?",
                     "hi, how are you", "hello how are you doing", "thanks", "thank you!", "bye",
                     "who are you", "namaste", "kaise ho", "ok"]:
            with self.subTest(text=text):
                self.assertEqual(small_talk_reply(text), GREETING_REPLY)

    def test_off_topic_questions_are_turned_away(self):
        for text in ["give me a pasta recipe", "what's the weather in Delhi", "write a poem about rain",
                     "tell me a joke", "who won the world cup", "write python code to sort a list",
                     "what is the capital of France"]:
            with self.subTest(text=text):
                self.assertEqual(small_talk_reply(text), OFF_TOPIC_REPLY)

    def test_finance_questions_pass_through(self):
        for text in ["hi, how has TCS done this year?", "should I buy this stock now?", "what is RSI",
                     "how is it", "is HDFC Bank expensive", "how does weather affect sugar stocks",
                     "best IT stocks", "kya reliance ka PE zyada hai", "hello, show me debt free companies",
                     "write a strategy to buy on RSI 30", "test buy when RSI crosses 30"]:
            with self.subTest(text=text):
                self.assertIsNone(small_talk_reply(text))

    def test_marker_detection(self):
        self.assertTrue(is_off_topic_marker("OFF_TOPIC"))
        self.assertTrue(is_off_topic_marker(" off_topic. "))
        self.assertFalse(is_off_topic_marker("TCS is off its highs because of a weak topic-heavy quarter."))


class GeminiFallbackTests(unittest.TestCase):
    def _response(self, status, text=None):
        r = mock.Mock(status_code=status)
        r.raise_for_status = mock.Mock()
        r.json.return_value = {"candidates": [{"content": {"parts": [
            {"text": "thinking...", "thought": True}, {"text": text or ""}]}}]}
        return r

    def test_retired_model_falls_through_to_the_next(self):
        calls = []

        def fake_post(url, headers, json, timeout):
            calls.append(url)
            return self._response(404) if len(calls) == 1 else self._response(200, "Answer")

        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "GEMINI_MODEL": "gemini-old"}), \
                mock.patch.object(llm_client.requests, "post", side_effect=fake_post):
            text = llm_client._gemini_chat([{"role": "user", "content": "q"}], 0.2, 100)
        self.assertEqual(text, "Answer")
        self.assertIn("gemini-old", calls[0])
        self.assertIn("gemini-flash-latest", calls[1])

    def test_key_is_sent_in_a_header(self):
        seen = {}

        def fake_post(url, headers, json, timeout):
            seen.update(url=url, headers=headers)
            return self._response(200, "ok")

        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}), \
                mock.patch.object(llm_client.requests, "post", side_effect=fake_post):
            llm_client._gemini_chat([{"role": "user", "content": "q"}], 0.2, 100)
        self.assertEqual(seen["headers"]["x-goog-api-key"], "test-key")
        self.assertNotIn("test-key", seen["url"])


if __name__ == "__main__":
    unittest.main()
