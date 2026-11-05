import os

# Tests never fetch headlines: building a call would otherwise call Google News.
os.environ.setdefault("NEWS_ARCHIVE_ENABLED", "false")
