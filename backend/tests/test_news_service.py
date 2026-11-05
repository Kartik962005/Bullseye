"""Headlines beside the calls, and the evening archive, without touching the network."""
import gzip
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from email.utils import format_datetime
from unittest import mock

from app.services import news_service as ns


def rss(*items):
    body = "".join(
        f"<item><title>{title}</title><link>https://example.com/{i}</link><pubDate>{format_datetime(when)}</pubDate></item>"
        for i, (title, when) in enumerate(items)
    )
    return f"<rss><channel>{body}</channel></rss>".encode()


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class NewsTests(unittest.TestCase):
    def setUp(self):
        ns._CACHE.clear()

    def test_company_names_are_searched_without_their_legal_suffix(self):
        self.assertEqual(ns.company_query("Solar Industries India Ltd."), '"Solar Industries India"')
        self.assertEqual(ns.company_query("Patanjali Foods Limited"), '"Patanjali Foods"')

    def test_headlines_are_newest_first_with_source_split_off_and_no_repeats(self):
        now = datetime.now(timezone.utc)
        feed = rss(("Old story - Mint", now - timedelta(hours=30)), ("Q2 results: profit up 79% - CNBC TV18", now - timedelta(hours=2)),
                   ("Q2 results: profit up 79% - CNBC TV18", now - timedelta(hours=3)))
        with mock.patch.object(ns.urllib.request, "urlopen", return_value=FakeResponse(feed)):
            stories = ns.headlines('"Solar Industries India"', days=3, limit=5)
        self.assertEqual([s["title"] for s in stories], ["Q2 results: profit up 79%", "Old story"])
        self.assertEqual(stories[0]["source"], "CNBC TV18")
        self.assertTrue(ns.is_big_news(stories[0]))
        self.assertFalse(ns.is_big_news(stories[1]))

    def test_big_news_has_to_be_about_the_company(self):
        self.assertEqual(ns.name_key("IDFC First Bank Ltd."), "IDFC First")
        self.assertEqual(ns.name_key("Patanjali Foods Ltd."), "Patanjali")
        self.assertEqual(ns.name_key("Tata Power Company Ltd."), "Tata Power")
        now = datetime.now(timezone.utc).isoformat()
        self.assertFalse(ns.is_big_news({"title": "US election results lift banking stocks", "published": now}, "IDFC First"))
        self.assertTrue(ns.is_big_news({"title": "IDFC First Bank Q2 results: profit up 12%", "published": now}, "IDFC First"))
        old = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        self.assertFalse(ns.is_big_news({"title": "IDFC First Bank Q2 results", "published": old}, "IDFC First"))

    def test_a_call_still_publishes_when_the_news_feed_fails(self):
        with mock.patch.object(ns.urllib.request, "urlopen", side_effect=OSError("offline")):
            self.assertIsNone(ns.call_headlines("Tata Power Company Ltd."))

    def test_the_archive_saves_one_compressed_file_a_day(self):
        now = datetime.now(timezone.utc)
        uploads = {}
        storage = mock.MagicMock()
        storage.from_.return_value.upload.side_effect = lambda path, payload, file_options: uploads.update(path=path, payload=payload)
        with mock.patch.object(ns.urllib.request, "urlopen", return_value=FakeResponse(rss(("Order win - ET", now)))):
            result = ns.archive_day(date(2026, 11, 5), [("TCS.NS", "Tata Consultancy Services Ltd.")], storage=storage, pause=0)
        self.assertEqual(uploads["path"], "news/2026-11-05.json.gz")
        saved = json.loads(gzip.decompress(uploads["payload"]))
        self.assertEqual(saved["stocks"]["TCS.NS"][0]["title"], "Order win")
        self.assertEqual((result["stocks"], result["failed"]), (1, 0))


if __name__ == "__main__":
    unittest.main()
