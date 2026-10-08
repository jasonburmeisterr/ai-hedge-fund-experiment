"""The fund tear sheet: the one-page summary an investor (or a recruiter) reads first.

From the equity curve (one sample per loop) and the books: since-inception return, annualized volatility, Sharpe and
Sortino (once there are 20+ days), max and current drawdown, best / worst day, share of up days, beta and correlation to
SPY, a monthly returns grid, and P&L attribution by pod, by asset group and by market (realized + open)."""
import math

import numpy as np
import pandas as pd

from . import config as C
from .riskbook import group_of


def daily_equity(curve):
    if len(curve) < 2:
        return pd.Series(dtype=float)
    s = pd.Series([c[1] for c in curve], index=pd.to_datetime([c[0] for c in curve], unit="s", utc=True).tz_convert("America/New_York"))
    return s.resample("1D").last().dropna()


def build(floor) -> dict:
    f = floor
    px = f.prices()
    eq_now = f.broker.equity(px)
    d = daily_equity(f.curve + [[int(pd.Timestamp.now(tz="UTC").timestamp()), eq_now]])
    start = C.STARTING_CASH
    out = dict(days=int(len(d)), total=eq_now / start - 1, nav=100 * eq_now / start)
    # daily returns, the first one measured from the starting capital
    r = pd.Series(np.r_[start, d.values], dtype=float).pct_change().dropna()
    r.index = d.index[:len(r)]
    peak = np.maximum.accumulate(np.r_[start, d.values]) if len(d) else np.array([start])
    dd = (np.r_[start, d.values] / peak - 1) if len(d) else np.array([0.0])
    out.update(maxdd=float(dd.min()), curdd=float(dd[-1]), best=float(r.max()) if len(r) else None, worst=float(r.min()) if len(r) else None,
               up_days=float((r > 0).mean()) if len(r) else None)
    if len(r) >= 20 and r.std() > 0:
        out["vol"] = float(r.std() * math.sqrt(252))
        out["sharpe"] = float(r.mean() / r.std() * math.sqrt(252))
        dn = r[r < 0]
        out["sortino"] = float(r.mean() / dn.std() * math.sqrt(252)) if len(dn) > 2 and dn.std() > 0 else None
        spy = f.desk.daily.get("SPY")
        if spy is not None and len(spy) > 30:
            sr = spy["Close"].pct_change()
            sr.index = pd.DatetimeIndex(sr.index).tz_localize(None).normalize()
            fr = r.copy(); fr.index = pd.DatetimeIndex(fr.index).tz_localize(None).normalize()
            j = pd.concat([fr, sr], axis=1, join="inner").dropna()
            if len(j) >= 15 and j.iloc[:, 1].std() > 0:
                out["corr_spy"] = float(j.iloc[:, 0].corr(j.iloc[:, 1]))
                out["beta_spy"] = float(np.cov(j.iloc[:, 0], j.iloc[:, 1])[0, 1] / j.iloc[:, 1].var())
    else:
        out.update(vol=None, sharpe=None, sortino=None)
    months = {}
    if len(d):
        m = d.resample("ME").last()
        prev = start
        for t, v in m.items():
            months[t.strftime("%Y-%m")] = round(float(v / prev - 1), 5)
            prev = v
    out["months"] = months
    # attribution: realized (per trade) + open P&L, by pod / asset group / market
    by_pod, by_grp, by_sym = {}, {}, {}
    def add(pod, sym, v):
        by_pod[pod] = by_pod.get(pod, 0.0) + v
        g = group_of(sym) if sym in C.INST else "Options"
        by_grp[g] = by_grp.get(g, 0.0) + v
        by_sym[sym] = by_sym.get(sym, 0.0) + v
    for pod, v in f.broker.realized.items():
        by_pod[pod] = by_pod.get(pod, 0.0)                     # pods with realized P&L show even if flat now
    for t in f.broker.trades:
        sym = t["sym"].split(" ")[0] if " " in t["sym"] else t["sym"]
        add(t.get("pod", "?"), sym, t["pnl"])
    for k, p in f.broker.positions.items():
        add(p["pod"], p["sym"], f.broker.upl(k, px.get(p["sym"], p["entry"])))
    for k, st in f.broker.opt.items():
        add(st["pod"], st["cur"], f.broker.opt_upl(k) - st["fees"])
    # the trade list is bounded: scale pod totals to the persisted realized totals so they stay exact
    for pod, real in f.broker.realized.items():
        shown = sum(t["pnl"] for t in f.broker.trades if t.get("pod") == pod)
        if abs(real - shown) > 0.01:
            by_pod[pod] = by_pod.get(pod, 0.0) + (real - shown)
    nm = f.names
    out["by_pod"] = sorted(([nm.get(k, k), round(v, 2)] for k, v in by_pod.items()), key=lambda x: -abs(x[1]))
    out["by_group"] = sorted(([k, round(v, 2)] for k, v in by_grp.items()), key=lambda x: -abs(x[1]))
    out["by_market"] = sorted(([k, round(v, 2)] for k, v in by_sym.items()), key=lambda x: -abs(x[1]))[:10]
    out["fees"] = f.broker.fees_paid
    out["interest"] = f.broker.interest_paid
    out["trades"] = len(f.broker.trades)
    wins = [t["pnl"] for t in f.broker.trades if t["pnl"] > 0]
    losses = [-t["pnl"] for t in f.broker.trades if t["pnl"] < 0]
    out["win_rate"] = len(wins) / len(f.broker.trades) if f.broker.trades else None
    out["pf"] = sum(wins) / sum(losses) if losses else None
    return out
