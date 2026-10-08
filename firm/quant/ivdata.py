"""Historical implied volatility: the market's own forecast of future volatility.

CBOE volatility indices (30-day implied vol of the options on an underlying), from Yahoo:
  ^VIX (S&P 500 -> SPY), ^VXN (Nasdaq-100 -> QQQ), ^GVZ (gold ETF -> GLD), ^OVX (oil ETF -> USO), ^VIX3M (3-month SPX,
  for the term structure). Deribit's DVOL (30-day implied vol of BTC / ETH options, since 2021).
Cached on disk for 12 hours. Values are annualized decimals (0.18 = 18 vol points)."""
import os
import time

import httpx
import pandas as pd
import yfinance as yf

from ..history import CACHE

MAX_AGE = 12 * 3600
CBOE = {"SPY": "^VIX", "QQQ": "^VXN", "GLD": "^GVZ", "USO": "^OVX", "VIX3M": "^VIX3M"}
DVOL = {"BTC": "BTC", "ETH": "ETH"}
IV_SYMS = ["SPY", "QQQ", "GLD", "USO", "BTC", "ETH"]       # underlyings with a historical implied-vol series


def _dvol(cur):
    rows, end = [], int(time.time() * 1000)
    start = int(pd.Timestamp("2021-03-01", tz="UTC").timestamp() * 1000)
    with httpx.Client(timeout=30, headers={"User-Agent": "jb-capital-floor/1.0"}) as cl:
        for _ in range(12):
            r = cl.get("https://www.deribit.com/api/v2/public/get_volatility_index_data",
                       params=dict(currency=cur, start_timestamp=start, end_timestamp=end, resolution="1D"))
            r.raise_for_status()
            res = r.json()["result"]
            rows += res["data"]
            cont = res.get("continuation")
            if not cont or cont <= start:
                break
            end = cont
            time.sleep(0.2)
    s = pd.Series({pd.Timestamp(t, unit="ms").normalize(): c for t, _o, _h, _l, c in rows}).sort_index()
    return (s[~s.index.duplicated()] / 100).astype(float)


def load_iv(force=False) -> dict[str, pd.Series]:
    """Blocking. {underlying: daily implied vol series (tz-naive dates)}; 'VIX3M' for the S&P term structure."""
    os.makedirs(CACHE, exist_ok=True)
    out = {}
    path = os.path.join(CACHE, "iv_cboe.pkl")
    if not force and os.path.exists(path) and time.time() - os.path.getmtime(path) < MAX_AGE:
        out.update(pd.read_pickle(path))
    else:
        try:
            raw = yf.download(list(CBOE.values()), start="2008-01-01", interval="1d", group_by="ticker", progress=False, auto_adjust=False)
            got = {}
            for sym, t in CBOE.items():
                try:
                    s = raw[t]["Close"].dropna() / 100
                    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                    if len(s) > 200:
                        got[sym] = s.astype(float)
                except Exception:
                    pass
            if got:
                pd.to_pickle(got, path)
            out.update(got)
        except Exception:
            if os.path.exists(path):
                out.update(pd.read_pickle(path))
    for sym, cur in DVOL.items():
        p = os.path.join(CACHE, f"iv_dvol_{cur}.pkl")
        if not force and os.path.exists(p) and time.time() - os.path.getmtime(p) < MAX_AGE:
            out[sym] = pd.read_pickle(p)
            continue
        try:
            s = _dvol(cur)
            if len(s) > 200:
                s.to_pickle(p)
                out[sym] = s
        except Exception:
            if os.path.exists(p):
                out[sym] = pd.read_pickle(p)
    return out
