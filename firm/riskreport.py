"""Rex's daily risk report: what a real risk desk sends the CIO every morning.

Value at Risk by historical simulation: today's book (every position's dollar exposure, options by their delta) is
replayed through each of the last 500 trading days' actual market moves. VaR 95 / 99 = the loss exceeded on only 5% / 1%
of those days; Expected Shortfall 97.5 = the average loss on the worst 2.5% (what Basel uses). Plus factor exposures
(dollar P&L for a 1% move in stocks, bonds, gold, oil, bitcoin, from a regression of the book's simulated P&L), each
pod's standalone VaR, and the worst day in the window. Recomputed every 15 minutes; Rex warns when 99% VaR is over
4% of NAV."""
import time

import numpy as np
import pandas as pd

from . import config as C

WINDOW = 500
WARN_VAR99 = 0.04
FACTORS = {"US stocks": "SPY", "Bonds": "TLT", "Gold": "GLD", "Oil": "USO", "Bitcoin": "BTC"}


class RiskReport:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.last: dict | None = None
        self.at = 0.0
        self.history: list = st.get("history", [])[-120:]        # [[date, var99 %NAV, es %NAV]]
        self.warned_day = st.get("warned_day")

    def to_state(self):
        return dict(history=self.history[-120:], warned_day=self.warned_day)

    def _exposures(self, px):
        f = self.f
        legs = {}
        for pod, sym, usd, _ in f.riskbook.legs(px):                 # shares, futures, crypto, stock-option spreads (by delta)
            legs.setdefault(pod, {}).setdefault(sym, 0.0)
            legs[pod][sym] += usd
        for k, stx in f.broker.opt.items():                          # Deribit structures: delta from the live chain
            if stx.get("venue") == "alpaca":
                continue
            d = 0.0
            for l in stx["legs"]:
                if l["name"] in f.chain.opts:
                    g, S = f.chain.greeks(l["name"]), f.chain.opts[l["name"]]["S"]
                    d += l["side"] * l["qty"] * g["delta"] * S
            legs.setdefault(stx["pod"], {}).setdefault(stx["cur"], 0.0)
            legs[stx["pod"]][stx["cur"]] += d
        return legs

    def compute(self):
        f = self.f
        px = f.prices()
        eq = f.broker.equity(px) or 1.0
        daily = f.desk.daily or f.lab.daily
        legs = self._exposures(px)
        syms = sorted({s for d in legs.values() for s in d} | set(FACTORS.values()))
        spy = daily.get("SPY")
        if spy is None or not len(spy):
            return None
        idx = pd.DatetimeIndex(spy.index).tz_localize(None).normalize() if getattr(spy.index, "tz", None) else pd.DatetimeIndex(spy.index).normalize()
        idx = idx[-(WINDOW + 1):]
        R = {}
        for s in syms:
            df = daily.get(s)
            if df is None or not len(df):
                continue
            c = df["Close"].copy()
            c.index = pd.DatetimeIndex(c.index).tz_localize(None).normalize() if getattr(c.index, "tz", None) else pd.DatetimeIndex(c.index).normalize()
            c = c[~c.index.duplicated(keep="last")].reindex(idx, method="ffill")           # crypto: business-day closes
            R[s] = c.pct_change().iloc[1:].fillna(0.0).values
        if not R:
            return None
        n = len(next(iter(R.values())))
        book = np.zeros(n)
        by_pod = {}
        for pod, d in legs.items():
            p = np.zeros(n)
            for s, usd in d.items():
                if s in R:
                    p += usd * R[s]
            by_pod[pod] = p
            book += p
        def var(x, q):
            return float(-np.quantile(x, q)) if len(x) else 0.0
        v95, v99 = var(book, 0.05), var(book, 0.01)
        tail = book[book <= np.quantile(book, 0.025)] if len(book) else book
        es = float(-tail.mean()) if len(tail) else 0.0
        F = np.column_stack([R[s] for s in FACTORS.values() if s in R])
        names = [k for k, s in FACTORS.items() if s in R]
        betas = {}
        if F.size and book.std() > 0:
            X = np.column_stack([np.ones(n), F])
            coef, *_ = np.linalg.lstsq(X, book, rcond=None)
            betas = {k: float(c * 0.01) for k, c in zip(names, coef[1:])}          # $ P&L for a 1% move
        worst_i = int(np.argmin(book)) if len(book) else 0
        gross = sum(abs(u) for d in legs.values() for u in d.values())
        net = sum(u for d in legs.values() for u in d.values())
        out = dict(t=time.time(), eq=eq, var95=v95, var99=v99, es=es, var95_pct=v95 / eq, var99_pct=v99 / eq, es_pct=es / eq,
                   worst=dict(pnl=float(book[worst_i]) if len(book) else 0.0, date=str(idx[1:][worst_i].date()) if len(book) else None),
                   best=float(book.max()) if len(book) else 0.0, days=n, gross=gross, net=net, factors=betas,
                   pods=sorted(([f.names.get(k, k), var(v, 0.05), var(v, 0.01)] for k, v in by_pod.items()), key=lambda x: -x[2]),
                   hist=[round(float(x), 2) for x in book[-250:]])
        return out

    async def step(self):
        f = self.f
        if time.time() - self.at < 900:
            return
        self.at = time.time()
        try:
            r = self.compute()
        except Exception as e:      # a reporting bug must never stop the floor
            r = None
            f.ops.error(f"risk report: {e!r}")
        if not r:
            return
        self.last = r
        day = time.strftime("%Y-%m-%d")
        if not self.history or self.history[-1][0] != day:
            self.history.append([day, round(r["var99_pct"], 5), round(r["es_pct"], 5)])
        else:
            self.history[-1] = [day, round(r["var99_pct"], 5), round(r["es_pct"], 5)]
        if r["var99_pct"] > WARN_VAR99 and self.warned_day != day:
            self.warned_day = day
            await f.say("rex", "risk", f"Risk report: 1-day 99% VaR is ${r['var99']:,.0f} ({r['var99_pct']:.1%} of NAV), expected shortfall "
                        f"${r['es']:,.0f}. That's above my {WARN_VAR99:.0%} comfort line: the book is too concentrated.", pause=1, ok=False)

    def line(self):
        r = self.last
        if not r:
            return ""
        top = max(r["factors"].items(), key=lambda kv: abs(kv[1]), default=None)
        return (f"1-day VaR 95% ${r['var95']:,.0f} ({r['var95_pct']:.1%}), 99% ${r['var99']:,.0f} ({r['var99_pct']:.1%}), expected shortfall "
                f"${r['es']:,.0f}" + (f"; biggest factor: {top[0]} (${top[1]:+,.0f} per 1% move)" if top else "") + ".")

    def snapshot(self):
        return dict(last=self.last, history=self.history[-60:], warn=WARN_VAR99)
