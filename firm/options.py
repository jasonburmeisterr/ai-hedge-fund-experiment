"""The options desk (Opal's pod). Live BTC/ETH option chains from Deribit (free public API, 24/7).
Prices are real: we buy at the ask and sell at the bid. Two strategies, both with defined risk:
  1. Sell volatility: when implied vol is well above realized vol (the variance risk premium),
     sell an iron condor (short ~20-delta call + put, long ~7-delta wings). Profits if price stays in a range.
  2. Buy volatility: when options are cheap vs realized vol and momentum agrees, buy an ATM call or put.
Greeks come from Black-Scholes using each option's own implied vol."""
import math
import time
from datetime import datetime, timezone

import httpx
import numpy as np

URL = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency"
CURRENCIES = ["BTC", "ETH"]
FEE_RATE, FEE_CAP = 0.0003, 0.125     # Deribit: 0.03% of underlying per contract, capped at 12.5% of the premium
MIN_QTY = {"BTC": 0.1, "ETH": 1.0}

# strategy settings
VRP_SELL, VRP_BUY = 1.20, 0.90         # IV/RV ratio thresholds
DTE_MIN, DTE_MAX, DTE_TARGET = 4, 21, 9
CONDOR_SHORT_DELTA, CONDOR_WING_DELTA = 0.20, 0.07
TAKE_PROFIT_CONDOR, STOP_CONDOR = 0.5, 1.5     # close at 50% of max credit / at a loss of 1.5x the credit
TAKE_PROFIT_LONG, STOP_LONG = 1.0, 0.5         # long options: +100% / -50%
CLOSE_DTE = 1.0


def _ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _npdf(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def bs(S, K, T, iv, kind):
    """Black-Scholes price and greeks (r = 0). iv as a decimal, T in years. Returns per 1 unit of underlying."""
    T = max(T, 1e-6)
    iv = max(iv, 1e-4)
    d1 = (math.log(S / K) + 0.5 * iv * iv * T) / (iv * math.sqrt(T))
    d2 = d1 - iv * math.sqrt(T)
    if kind == "C":
        price, delta = S * _ncdf(d1) - K * _ncdf(d2), _ncdf(d1)
    else:
        price, delta = K * _ncdf(-d2) - S * _ncdf(-d1), _ncdf(d1) - 1
    gamma = _npdf(d1) / (S * iv * math.sqrt(T))
    vega = S * _npdf(d1) * math.sqrt(T) / 100            # per 1 vol point
    theta = -S * _npdf(d1) * iv / (2 * math.sqrt(T)) / 365  # per day
    return dict(price=price, delta=delta, gamma=gamma, vega=vega, theta=theta)


def parse(name):
    cur, exp, strike, kind = name.split("-")
    dt = datetime.strptime(exp, "%d%b%y").replace(hour=8, tzinfo=timezone.utc)   # Deribit expiry 08:00 UTC
    return cur, dt.timestamp(), float(strike), kind


class Chain:
    """Latest option chain per currency: {name: dict(strike, kind, expiry, bid, ask, mark, iv, S)} (prices in USD)."""

    def __init__(self):
        self.opts: dict[str, dict] = {}
        self.index: dict[str, float] = {}
        self.updated = 0.0
        self.error = None

    async def refresh(self):
        self.error = None
        try:
            async with httpx.AsyncClient(timeout=15, headers={"User-Agent": "jb-capital-fund/1.0"}) as cl:
                for cur in CURRENCIES:
                    r = await cl.get(URL, params={"currency": cur, "kind": "option"})
                    r.raise_for_status()
                    for o in r.json()["result"]:
                        S = o.get("estimated_delivery_price") or o.get("underlying_price")
                        if not S or not o.get("mark_price"):
                            continue
                        c, exp, k, kind = parse(o["instrument_name"])
                        usd = lambda p: p * S if p else None  # noqa: E731 - premiums are quoted in the coin
                        self.opts[o["instrument_name"]] = dict(
                            cur=c, exp=exp, strike=k, kind=kind, S=S, iv=(o.get("mark_iv") or 0) / 100,
                            mark=usd(o["mark_price"]), bid=usd(o.get("bid_price")), ask=usd(o.get("ask_price")),
                            oi=o.get("open_interest") or 0)
                        self.index[c] = S
            self.updated = time.time()
        except Exception as e:
            self.error = f"{type(e).__name__} {e}"[:80]

    def expiries(self, cur):
        now = time.time()
        return sorted({o["exp"] for o in self.opts.values() if o["cur"] == cur and o["exp"] > now})

    def pick_expiry(self, cur):
        now = time.time()
        ok = [e for e in self.expiries(cur) if DTE_MIN <= (e - now) / 86400 <= DTE_MAX]
        return min(ok, key=lambda e: abs((e - now) / 86400 - DTE_TARGET)) if ok else None

    def strip(self, cur, exp, kind):
        return sorted(((n, o) for n, o in self.opts.items() if o["cur"] == cur and o["exp"] == exp and o["kind"] == kind),
                      key=lambda x: x[1]["strike"])

    def atm_iv(self, cur, exp):
        S = self.index.get(cur)
        if not S:
            return None
        ivs = []
        for kind in "CP":
            strip = self.strip(cur, exp, kind)
            if strip:
                n, o = min(strip, key=lambda x: abs(x[1]["strike"] - S))
                if o["iv"] > 0:
                    ivs.append(o["iv"])
        return sum(ivs) / len(ivs) if ivs else None

    def greeks(self, name):
        o = self.opts[name]
        T = max((o["exp"] - time.time()) / (365 * 86400), 1e-6)
        return bs(o["S"], o["strike"], T, o["iv"] or 0.5, o["kind"])

    def by_delta(self, cur, exp, kind, target):
        """Strike whose |delta| is closest to target (OTM side), with a usable quote."""
        best = None
        for n, o in self.strip(cur, exp, kind):
            if not o["bid"] or not o["ask"]:
                continue
            d = abs(self.greeks(n)["delta"])
            if d > 0.5:
                continue
            if best is None or abs(d - target) < abs(best[1] - target):
                best = (n, d)
        return best[0] if best else None

    def atm(self, cur, exp, kind):
        S = self.index.get(cur)
        strip = [(n, o) for n, o in self.strip(cur, exp, kind) if o["ask"]]
        return min(strip, key=lambda x: abs(x[1]["strike"] - S))[0] if strip and S else None


def fee(o, qty, px):
    return min(FEE_RATE * o["S"], FEE_CAP * px) * qty


def realized_vol(df):
    """Annualized realized vol from 15-minute closes (crypto trades 24/7)."""
    r = np.diff(np.log(df["Close"].values[-500:]))
    return float(r.std() * math.sqrt(96 * 365)) if len(r) > 50 else None


def label(legs):
    if len(legs) == 4:
        return "iron condor"
    leg = legs[0]
    return f"long {'call' if leg['kind'] == 'C' else 'put'}"
