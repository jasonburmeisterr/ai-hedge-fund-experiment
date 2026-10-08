"""Fund math: NAV, Sharpe, volatility, drawdown, and how the CIO allocates capital across pods."""
import math

import pandas as pd

from . import config as C


def metrics(curve: list, start: float) -> dict:
    """curve = [[unix_ts, equity], ...] sampled every minute."""
    if len(curve) < 2:
        return dict(nav=100.0, sharpe=None, vol=None, maxdd=0.0, hours=0)
    s = pd.Series([c[1] for c in curve], index=pd.to_datetime([c[0] for c in curve], unit="s"))
    nav = 100 * s.iloc[-1] / start
    dd = float((s / s.cummax() - 1).min())
    h = s.resample("1h").last().dropna()
    r = h.pct_change().dropna()
    sharpe = vol = None
    if len(r) >= 24 and r.std() > 0:  # need a day of hourly returns before these mean anything
        ann = math.sqrt(24 * 365)
        sharpe = float(r.mean() / r.std() * ann)
        vol = float(r.std() * ann)
    return dict(nav=float(nav), sharpe=sharpe, vol=vol, maxdd=dd, hours=len(h))


def overlap_factors(active: list, report: dict | None) -> dict:
    """How many 'copies' of each pod's bet the active team holds: 1 + its positive return correlations with the others
    (Dot's report). A pod in a cluster of 4 look-alikes scores ~2.5-3; a genuinely different one ~1. Pods the report
    doesn't cover (options desk, brand-new hires) get the team median, so they're neither rewarded nor punished."""
    if not report or not report.get("corr"):
        return {}
    ids = [i for i in report["ids"] if i in active]
    ix = {i: report["ids"].index(i) for i in ids}
    d = {i: 1.0 + sum(max(0.0, report["corr"][ix[i]][ix[j]]) for j in ids if j != i) for i in ids}
    if not d:
        return {}
    mid = sorted(d.values())[len(d) // 2]
    return {i: round(d.get(i, mid), 2) for i in active}


def allocate(roster: list, stats: dict, inactive: set, report: dict | None = None) -> tuple[dict, dict]:
    """CIO capital allocation: proportional to trust (earned from graded calls) divided by how crowded the pod's bet
    is (overlap_factors), so a cluster of look-alike PMs shares one budget instead of getting one each. Each active pod
    gets between MIN_ALLOC and MAX_ALLOC, inactive pods (benched / stopped out) get 0. Returns (alloc, overlap factors)."""
    active = [a["id"] for a in roster if a["id"] not in inactive]
    if not active:
        return {a["id"]: 0.0 for a in roster}, {}
    dup = overlap_factors(active, report)
    raw = {i: max(0.1, stats[i]["trust"]) / dup.get(i, 1.0) for i in active}
    tot = sum(raw.values())
    w = {i: v / tot for i, v in raw.items()}
    for _ in range(5):  # clamp, then renormalize
        w = {i: min(C.MAX_ALLOC, max(C.MIN_ALLOC, v)) for i, v in w.items()}
        tot = sum(w.values())
        w = {i: v / tot for i, v in w.items()}
    return {a["id"]: round(w.get(a["id"], 0.0), 4) for a in roster}, dup
