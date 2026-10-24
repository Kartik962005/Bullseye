"""Build the forecast universe and its training history.

1. Pull the current Nifty 200 constituents (with NSE's industry for each) and
   save them to app/services/daily_signal_engine/data/forecast_universe.csv.
   The live engine forecasts exactly these stocks, so training and live use
   the same universe, the same sectors and the same market-breadth pool.
2. Download ~10 years of daily, split-adjusted prices for each stock and the
   Nifty 50 from Yahoo's chart API into scripts/frames_forecast.pkl (local
   cache, not committed).

    cd backend
    python scripts/build_forecast_universe.py            # both steps
    python scripts/build_forecast_universe.py --prices   # refresh prices only

Survivorship note: these are today's constituents, tested over past years, so
stocks that were later dropped from the index are missing. That biases
absolute returns upward more than it affects which stocks beat the others,
which is what the model ranks.
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import time

import pandas as pd
import requests

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _BACKEND)
sys.path.insert(0, _HERE)

from app.services.data_service import _fetch_yahoo_chart_data  # noqa: E402
from ingest_history import BROWSER_HEADERS, NSE_HOME  # noqa: E402

UNIVERSE_CSV = os.path.join(_BACKEND, "app", "services", "daily_signal_engine", "data", "forecast_universe.csv")
FRAMES_CACHE = os.path.join(_HERE, "frames_forecast.pkl")
NIFTY200_CSV = "https://nsearchives.nseindia.com/content/indices/ind_nifty200list.csv"
INDEX = "^NSEI"


def fetch_universe() -> pd.DataFrame:
    session = requests.Session()
    session.get(NSE_HOME, headers=BROWSER_HEADERS, timeout=10)
    response = session.get(NIFTY200_CSV, headers=BROWSER_HEADERS, timeout=20)
    response.raise_for_status()
    raw = pd.read_csv(io.StringIO(response.text))
    universe = pd.DataFrame({
        "ticker": raw["Symbol"].str.strip() + ".NS",
        "symbol": raw["Symbol"].str.strip(),
        "company": raw["Company Name"].str.strip(),
        "sector": raw["Industry"].str.strip(),
    }).sort_values("ticker").reset_index(drop=True)
    os.makedirs(os.path.dirname(UNIVERSE_CSV), exist_ok=True)
    universe.to_csv(UNIVERSE_CSV, index=False)
    print(f"Saved {len(universe)} stocks to {UNIVERSE_CSV}")
    return universe


def fetch_prices(tickers: list[str]) -> None:
    frames: dict[str, pd.DataFrame] = {}
    failed: list[str] = []
    for i, ticker in enumerate(tickers, 1):
        for attempt in range(3):
            try:
                df = _fetch_yahoo_chart_data(ticker, range_key="10y", interval="1d")
                df = df[["date", "open", "high", "low", "close", "volume"]].dropna(subset=["open", "high", "low", "close"])
                frames[ticker] = df.reset_index(drop=True)
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == 2:
                    failed.append(ticker)
                    print(f"  {ticker}: failed ({exc})")
                time.sleep(2 * (attempt + 1))
        if i % 25 == 0:
            print(f"  {i}/{len(tickers)} downloaded")
        time.sleep(0.25)
    index = frames.pop(INDEX)
    pd.to_pickle({"price_frames": frames, "index_frame": index, "failed": failed}, FRAMES_CACHE)
    bars = sum(len(f) for f in frames.values())
    print(f"Saved {len(frames)} stocks ({bars:,} bars) + {INDEX} to {FRAMES_CACHE}; failed: {failed}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", action="store_true", help="refresh prices only, keep the saved universe")
    args = ap.parse_args()
    universe = pd.read_csv(UNIVERSE_CSV) if args.prices else fetch_universe()
    fetch_prices(list(universe["ticker"]) + [INDEX])


if __name__ == "__main__":
    main()
