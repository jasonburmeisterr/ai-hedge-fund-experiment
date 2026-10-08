"""Historical 15-minute bars for the backtest machine, cached on disk (refreshed every 12 hours).
Crypto: ~90 days from Coinbase (paged, 300 candles per request). Stocks/futures: 60 days from Yahoo."""
import os
import time

import httpx
import pandas as pd
import yfinance as yf

from .config import INTRADAY as INSTRUMENTS, BAR_MINUTES

CACHE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data_cache")
MAX_AGE = 12 * 3600
CRYPTO_DAYS = 90


def _coinbase(product: str) -> pd.DataFrame:
    gran = BAR_MINUTES * 60
    end = int(time.time())
    start_all = end - CRYPTO_DAYS * 86400
    rows = []
    with httpx.Client(headers={"User-Agent": "jb-capital-floor/1.0"}, timeout=20) as cl:
        while end > start_all:
            start = max(start_all, end - 300 * gran)
            r = cl.get(f"https://api.exchange.coinbase.com/products/{product}/candles",
                       params={"granularity": gran, "start": pd.Timestamp(start, unit="s", tz="UTC").isoformat(),
                               "end": pd.Timestamp(end, unit="s", tz="UTC").isoformat()})
            r.raise_for_status()
            rows += r.json()
            end = start
            time.sleep(0.15)  # be polite to the public API
    df = pd.DataFrame(rows, columns=["t", "Low", "High", "Open", "Close", "Volume"]).drop_duplicates("t")
    df.index = pd.to_datetime(df["t"], unit="s", utc=True)
    return df[["Open", "High", "Low", "Close", "Volume"]].sort_index().astype(float)


def _yahoo(ids):
    raw = yf.download(ids, period="60d", interval=f"{BAR_MINUTES}m", group_by="ticker",
                      progress=False, auto_adjust=False, threads=True)
    out = {}
    for i in ids:
        try:
            df = raw[i][["Open", "High", "Low", "Close", "Volume"]].dropna()
            df.index = pd.to_datetime(df.index, utc=True)
            if len(df):
                out[i] = df.astype(float)
        except KeyError:
            pass
    return out


def load(force=False) -> dict[str, pd.DataFrame]:
    """Blocking (run in a thread). Returns {sym: DataFrame}."""
    os.makedirs(CACHE, exist_ok=True)
    out, need_yahoo = {}, []
    for inst in INSTRUMENTS:
        path = os.path.join(CACHE, f"{inst['sym']}.pkl")
        fresh = os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE
        if fresh and not force:
            out[inst["sym"]] = pd.read_pickle(path)
            continue
        if inst["src"] == "coinbase":
            try:
                df = _coinbase(inst["id"])
                df.to_pickle(path)
                out[inst["sym"]] = df
            except Exception:
                if os.path.exists(path):
                    out[inst["sym"]] = pd.read_pickle(path)
        else:
            need_yahoo.append(inst)
    if need_yahoo:
        try:
            frames = _yahoo([i["id"] for i in need_yahoo])
        except Exception:
            frames = {}
        for inst in need_yahoo:
            path = os.path.join(CACHE, f"{inst['sym']}.pkl")
            if inst["id"] in frames:
                frames[inst["id"]].to_pickle(path)
                out[inst["sym"]] = frames[inst["id"]]
            elif os.path.exists(path):
                out[inst["sym"]] = pd.read_pickle(path)
    return out


# ── daily history: ~10+ years for the whole universe ─────────
DAILY_START = "2014-01-01"


def load_daily(force=False) -> dict[str, pd.DataFrame]:
    """Blocking. Daily OHLC since 2014 for every instrument (crypto from its listing date), cached 12h."""
    from .config import INSTRUMENTS
    os.makedirs(CACHE, exist_ok=True)
    out, need = {}, []
    for inst in INSTRUMENTS:
        path = os.path.join(CACHE, f"daily_{inst['sym']}.pkl")
        if not force and os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE:
            out[inst["sym"]] = pd.read_pickle(path)
        else:
            need.append(inst)
    # crypto one by one (mixing 7-day and 5-day calendars in one download drops rows), the rest in one batch
    groups = [[i] for i in need if i["cls"] == "crypto"] + [[i for i in need if i["cls"] != "crypto"]]
    for grp in groups:
        if not grp:
            continue
        try:
            raw = yf.download([i["id"] for i in grp], start=DAILY_START, interval="1d", group_by="ticker",
                              progress=False, auto_adjust=True, threads=True)
        except Exception:
            raw = None
        for inst in grp:
            path = os.path.join(CACHE, f"daily_{inst['sym']}.pkl")
            try:
                df = raw[inst["id"]][["Open", "High", "Low", "Close", "Volume"]].dropna().astype(float)
                df.index = pd.to_datetime(df.index)
                df.to_pickle(path)
                out[inst["sym"]] = df
            except Exception:
                if os.path.exists(path):
                    out[inst["sym"]] = pd.read_pickle(path)
    return out
