"""The 1-hour desk: years of hourly history for research AND the live hourly bars the 1h PMs trade on.

Same data source for both, so what the lab tests is what the PMs trade:
  - US ETFs/stocks: Alpaca SIP 1-hour bars since 2016 (free plan: SIP is allowed when the data is >15 min old), regular
    hours only (bars starting 9:00-15:00 New York time). The newest hour comes from Alpaca's free real-time IEX feed
    until SIP has it, then SIP replaces it.
  - Crypto (BTC/ETH/SOL): Alpaca crypto 1-hour bars (24/7) since 2021.
  - Futures stay on daily bars for now (free intraday futures history is too short; real-time CME data is an earned unlock).
History is cached in data_cache/hourly_<SYM>.pkl; the first download takes a while (it runs in the background), after that
only the last few days are refreshed. Only COMPLETED bars are ever used."""
import datetime as dt
import os
import time

import httpx
import pandas as pd

from . import config as C

CACHE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data_cache")
START = "2016-01-01"
NY = "America/New_York"
CRYPTO_PAIR = {"BTC": "BTC/USD", "ETH": "ETH/USD", "SOL": "SOL/USD"}
HOURLY_UNIVERSE = [i["sym"] for i in C.INSTRUMENTS if i["cls"] in ("etf", "stock")] + list(CRYPTO_PAIR)
REFRESH_SEC = 300


def _headers():
    return {"APCA-API-KEY-ID": C.ALPACA_KEY, "APCA-API-SECRET-KEY": C.ALPACA_SECRET}


def _iso(t):
    return pd.Timestamp(t).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def _frame(rows):
    if not rows:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"], dtype=float)
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["t"], utc=True)
    df = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
    return df[["Open", "High", "Low", "Close", "Volume"]].astype(float).sort_index()


def _pages(cl, url, params, key):
    rows, tok = [], None
    while True:
        p = dict(params, limit=10000)
        if tok:
            p["page_token"] = tok
        for attempt in range(6):      # Alpaca allows ~200 requests/min: back off on 429 / server errors
            try:
                r = cl.get(url, params=p)
            except httpx.TransportError:
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, 3 * 2 ** attempt))
                continue
            break
        r.raise_for_status()
        time.sleep(0.35)
        j = r.json()
        rows += (j.get("bars") or {}).get(key, [])
        tok = j.get("next_page_token")
        if not tok:
            return rows


def rth(df):
    """Regular trading hours only: hourly bars starting 9:00..15:00 New York time on weekdays."""
    if not len(df):
        return df
    ny = df.index.tz_convert(NY)
    return df[(ny.hour >= 9) & (ny.hour <= 15) & (ny.weekday < 5)]


def fetch(sym, start, end=None):
    """Blocking. Hourly bars for one symbol from `start`."""
    with httpx.Client(headers=_headers(), timeout=60) as cl:
        if sym in CRYPTO_PAIR:
            pair = CRYPTO_PAIR[sym]
            rows = _pages(cl, "https://data.alpaca.markets/v1beta3/crypto/us/bars",
                          dict(symbols=pair, timeframe="1Hour", start=_iso(start), **({"end": _iso(end)} if end else {})), pair)
            return _frame(rows)
        sip_end = pd.Timestamp.now(tz="UTC").floor("h") - pd.Timedelta(hours=1)      # SIP needs data >15 min old
        if end is not None:
            sip_end = min(sip_end, pd.Timestamp(end))
        rows = _pages(cl, "https://data.alpaca.markets/v2/stocks/bars",
                      dict(symbols=sym, timeframe="1Hour", start=_iso(start), end=_iso(sip_end), feed="sip", adjustment="all"), sym)
        df = _frame(rows)
        if end is None:   # the newest hour(s) from the free real-time IEX feed
            last = df.index[-1] if len(df) else pd.Timestamp(start, tz="UTC")
            iex = _frame(_pages(cl, "https://data.alpaca.markets/v2/stocks/bars",
                                dict(symbols=sym, timeframe="1Hour", start=_iso(last + pd.Timedelta(hours=1)), feed="iex", adjustment="all"), sym))
            df = pd.concat([df, iex[~iex.index.isin(df.index)]]).sort_index()
        return rth(df)


def completed(sym, df, now=None):
    """Drop the bar that is still forming. Stock bars end at min(start + 1h, 16:00 NY)."""
    if not len(df):
        return df
    now = now or pd.Timestamp.now(tz="UTC")
    ends = df.index + pd.Timedelta(hours=1)
    if sym not in CRYPTO_PAIR:
        ny = df.index.tz_convert(NY)
        close = pd.DatetimeIndex([t.normalize() + pd.Timedelta(hours=16) for t in ny]).tz_convert("UTC")
        ends = ends.where(ends <= close, close)
    return df[ends <= now]


def path(sym):
    return os.path.join(CACHE, f"hourly_{sym}.pkl")


def load_hourly(syms=None, max_age=6 * 3600, progress=None) -> dict:
    """Blocking. {sym: completed hourly bars}, from cache, topping up stale ones. Missing history is downloaded
    (slow the first time: a few minutes per symbol)."""
    os.makedirs(CACHE, exist_ok=True)
    out = {}
    if not (C.ALPACA_KEY and C.ALPACA_SECRET):
        return out
    for sym in syms or HOURLY_UNIVERSE:
        p = path(sym)
        old = pd.read_pickle(p) if os.path.exists(p) else None
        if old is not None and time.time() - os.path.getmtime(p) < max_age:
            out[sym] = old
            continue
        try:
            if progress:
                progress(sym)
            start = (old.index[-1] - pd.Timedelta(days=5)) if old is not None and len(old) else pd.Timestamp(START, tz="UTC")
            new = fetch(sym, start)
            df = new if old is None else pd.concat([old[old.index < new.index[0]] if len(new) else old, new]).sort_index()
            df = df[~df.index.duplicated(keep="last")]
            df.to_pickle(p)
            out[sym] = df
        except Exception:
            if old is not None:
                out[sym] = old
    return {s: completed(s, df) for s, df in out.items()}


class HourlyDesk:
    """Live hourly bars for the 1h PMs: refreshed every few minutes in the background."""
    def __init__(self):
        self.bars: dict = {}
        self.last = 0.0
        self.loading = False
        self.status = "not loaded"

    async def refresh(self):
        import asyncio
        if self.loading or time.time() - self.last < REFRESH_SEC:
            return False
        self.loading = True
        try:
            first = not self.bars
            self.status = "downloading years of hourly history (first run)" if first else "refreshing"
            data = await asyncio.to_thread(load_hourly, None, 0 if not first else 6 * 3600,
                                           lambda s: setattr(self, "status", f"loading {s}"))
            if data:
                self.bars = data
            self.last = time.time()
            self.status = f"{len(self.bars)} markets" if self.bars else "no data (Alpaca keys?)"
            return first and bool(self.bars)
        finally:
            self.loading = False
