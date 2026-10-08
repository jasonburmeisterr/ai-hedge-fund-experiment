"""Honest out-of-sample validation for a forecasting model.

  1. Walk-forward: train on everything before a block, predict the next quarter (63 trading days), roll forward, retrain.
     Training stops h + 5 days before each block (purge + embargo), so no training label overlaps what is predicted.
  2. The last 504 trading days (~2 years) are a SEALED HOLDOUT: reported separately and never used to pick models.
  3. Information coefficient (IC): each day, the rank correlation between the forecasts and the returns that followed.
     Its t-stat uses Newey-West errors (overlapping h-day returns make naive t-stats too optimistic).
  4. Null model: each market's forecast series is circularly shifted by a random amount 100 times (same forecasts, wrong
     dates). The real IC must beat 95% of those (p <= 0.05).
  5. Portfolio: forecasts become positions (cross-section: long the top-ranked markets, short the bottom; timing: each
     market long/short by its own forecast), volatility-scaled, smoothed over the horizon, charged each market's real
     costs on turnover. Reported at 10% target volatility.
  6. Alpha: the portfolio's daily returns regressed on an equal-risk buy-and-hold of the same markets."""
import math

import numpy as np
import pandas as pd

from .. import config as C
from .learn import fit

STEP, EMBARGO, HOLDOUT, MIN_TRAIN = 63, 5, 504, 756
TARGET_VOL = 0.10


def nw_t(x, lag):
    """t-stat of the mean with Newey-West (Bartlett) standard errors."""
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 20:
        return 0.0
    e = x - x.mean()
    s = e @ e / n
    for k in range(1, min(lag, n - 1) + 1):
        s += 2 * (1 - k / (lag + 1)) * (e[k:] @ e[:-k]) / n
    return float(x.mean() / math.sqrt(max(s, 1e-18) / n))


def walk_forward(P, feats, h, learner, syms=None, alpha=10.0):
    X, y = P["X"][feats], P[f"y{h}"]
    if syms:
        keep = X.index.get_level_values("sym").isin(syms)
        X, y = X[keep], y[keep]
    good = X.notna().mean(axis=1) >= 0.7
    X, y = X[good], y[good]
    dates = X.index.get_level_values("date")
    ud = np.array(sorted(dates.unique()))
    if len(ud) < MIN_TRAIN + 2 * STEP:
        raise ValueError("not enough history")
    out = np.full(len(X), np.nan)
    Xv, yv = X.values, y.values
    dv = dates.values
    last = None
    for i in range(MIN_TRAIN, len(ud), STEP):
        t0 = ud[i]
        t1 = ud[min(i + STEP, len(ud)) - 1]
        cut = ud[max(0, i - h - EMBARGO)]
        tr = (dv < cut) & np.isfinite(yv)
        te = (dv >= t0) & (dv <= t1)
        if tr.sum() < 2000 or not te.any():
            continue
        last = fit(learner, Xv[tr], yv[tr], alpha=alpha, seed=i)
        out[te] = last.predict(Xv[te])
    ok = np.isfinite(yv)
    final = fit(learner, Xv[ok], yv[ok], alpha=alpha, seed=7)       # the live model: all data
    pred = pd.Series(out, index=X.index)
    return pred.dropna(), final, ud[-HOLDOUT] if len(ud) > HOLDOUT + MIN_TRAIN else ud[-1]


def _xs_ic(pred, y):
    """Daily cross-sectional rank IC series."""
    df = pd.DataFrame({"p": pred, "y": y}).dropna()
    g = df.groupby(level="date")
    n = g["p"].transform("count")
    df = df[n >= 6]
    if df.empty:
        return pd.Series(dtype=float)
    g = df.groupby(level="date")
    rp = g["p"].rank() - g["p"].transform("count").add(1) / 2
    ry = g["y"].rank() - g["y"].transform("count").add(1) / 2
    num = (rp * ry).groupby(level="date").sum()
    den = np.sqrt((rp ** 2).groupby(level="date").sum() * (ry ** 2).groupby(level="date").sum())
    return (num / den.replace(0, np.nan)).dropna()


def _ts_ic(pred, y):
    """Timing IC: each market's forecast vs its own forward return (forecast z-scored per market), pooled by day."""
    df = pd.DataFrame({"p": pred, "y": y}).dropna()
    g = df.groupby(level="sym")["p"]
    z = (df["p"] - g.transform(lambda s: s.expanding(60).mean().shift())) / g.transform(lambda s: s.expanding(60).std().shift())
    df = df.assign(z=z).dropna()
    prod = (df["z"].clip(-3, 3) * df["y"]).groupby(level="date").mean()
    scale = df["y"].std() or 1
    return (prod / scale).dropna()


def ic_series(pred, y, style):
    return _xs_ic(pred, y) if style == "cross_section" else _ts_ic(pred, y)


def positions(pred, P, style, h):
    """Target weights (date x sym), volatility-scaled, smoothed over ~h/2 days."""
    vd = P["vd"].reindex(pred.index)
    df = pd.DataFrame({"p": pred, "vd": vd}).dropna()
    if style == "cross_section":
        g = df.groupby(level="date")["p"]
        cnt = g.transform("count")
        s = (g.rank() - (cnt + 1) / 2) / (cnt / 2)
        s = s.where(cnt >= 6, 0.0)
    else:
        g = df.groupby(level="sym")["p"]
        mu = g.transform(lambda x: x.expanding(60).mean().shift())
        sd = g.transform(lambda x: x.expanding(60).std().shift())
        s = ((df["p"] - mu) / sd).clip(-2, 2) / 2
    w = (s / df["vd"]).unstack("sym").fillna(0.0)
    if h > 1:
        w = w.ewm(halflife=max(1.0, h / 2), adjust=False).mean()
    return w


def portfolio(pred, P, style, h):
    """Daily net returns at 10% target vol, turnover, costs."""
    w = positions(pred, P, style, h)
    r1 = P["r1"].unstack("sym").reindex(index=w.index, columns=w.columns).fillna(0.0)
    gross = (w * r1).sum(axis=1)
    cost_rate = pd.Series({s: C.INST[s].get("fee_pct", 0) + C.INST[s]["slip_pct"] for s in w.columns})
    turn = w.diff().abs().fillna(w.abs())
    cost = (turn * cost_rate).sum(axis=1)
    raw = gross - cost
    vol = raw.std() * math.sqrt(252)
    k = TARGET_VOL / vol if vol > 0 else 0.0
    return raw * k, float((turn.sum(axis=1) * k).mean() * 252), float((cost * k).sum() / max(len(cost) / 252, 1))


def benchmark(P, index):
    """Equal-risk buy-and-hold of the same markets (what being long everything earns)."""
    vd = P["vd"].unstack("sym")
    r1 = P["r1"].unstack("sym")
    w = (1 / vd).div((1 / vd).sum(axis=1), axis=0)
    return (w * r1).sum(axis=1).reindex(index).fillna(0.0)


def stats(ret):
    ret = ret.dropna()
    if len(ret) < 60 or ret.std() == 0:
        return dict(sharpe=0.0, cagr=0.0, maxdd=0.0, n=len(ret))
    eq = np.exp(ret.cumsum())
    yrs = len(ret) / 252
    return dict(sharpe=float(ret.mean() / ret.std() * math.sqrt(252)), cagr=float(eq.iloc[-1] ** (1 / yrs) - 1),
                maxdd=float((eq / eq.cummax() - 1).min()), n=len(ret))


def alpha(ret, bench):
    df = pd.concat([ret, bench], axis=1).dropna()
    if len(df) < 120:
        return 0.0, 0.0, 0.0
    a, b = df.iloc[:, 0].values, df.iloc[:, 1].values
    beta = float(np.cov(a, b)[0, 1] / max(np.var(b), 1e-18))
    resid = a - beta * b
    return float(resid.mean() * 252), nw_t(resid, 5), beta


def permutation_p(pred, y, style, actual, n=100, seed=0):
    """Share of circularly-shifted forecast series whose mean IC is >= the real one."""
    rng = np.random.default_rng(seed)
    df = pd.DataFrame({"p": pred, "y": y}).dropna()
    groups = {s: g for s, g in df.groupby(level="sym")}
    beat = 0
    for _ in range(n):
        parts = []
        for s, g in groups.items():
            k = int(rng.integers(63, max(64, len(g) - 63)))
            parts.append(pd.Series(np.roll(g["p"].values, k), index=g.index))
        sh = pd.concat(parts)
        ic = ic_series(sh, df["y"], style)
        if len(ic) and ic.mean() >= actual:
            beat += 1
    return (beat + 1) / (n + 1)


def required_t(n_tests):
    return 1.5 + 0.4 * math.log(1 + max(0, n_tests))


def evaluate(P, spec, n_tests):
    """Full model test. spec: {features, horizon, learner, style, markets?}. Returns (result dict, final model, OOS preds)."""
    feats, h, learner, style = spec["features"], int(spec["horizon"]), spec["learner"], spec["style"]
    pred, final, hold_start = walk_forward(P, feats, h, learner, spec.get("markets"))
    y = P[f"y{h}"].reindex(pred.index)
    dev = pred[pred.index.get_level_values("date") < hold_start]
    hold = pred[pred.index.get_level_values("date") >= hold_start]
    ic_dev, ic_hold = ic_series(dev, y.reindex(dev.index), style), ic_series(hold, y.reindex(hold.index), style)
    t_dev = nw_t(ic_dev.values, h)
    port, turnover, cost_yr = portfolio(pred, P, style, h)
    bench = benchmark(P, port.index)
    pd_dev, pd_hold = port[port.index < hold_start], port[port.index >= hold_start]
    a_ann, a_t, beta = alpha(pd_dev, bench[bench.index < hold_start])
    sd, sh = stats(pd_dev), stats(pd_hold)
    by_year = ic_dev.groupby(ic_dev.index.year).mean()
    pos_years = float((by_year > 0).mean()) if len(by_year) else 0.0
    perm = permutation_p(dev, y.reindex(dev.index), style, float(ic_dev.mean()) if len(ic_dev) else 0.0) if len(ic_dev) and ic_dev.mean() > 0 else 1.0
    need = required_t(n_tests)
    imp = final.importance(feats)
    sign = final.signed(feats)
    eq = np.exp(port.cumsum()).resample("ME").last()
    res = dict(ic=float(ic_dev.mean()) if len(ic_dev) else 0.0, ic_t=t_dev, need_t=need, ic_hold=float(ic_hold.mean()) if len(ic_hold) else 0.0,
               ic_years={int(k): round(float(v), 4) for k, v in by_year.items()}, pos_years=pos_years, perm_p=perm,
               sharpe=sd["sharpe"], cagr=sd["cagr"], maxdd=sd["maxdd"], sharpe_hold=sh["sharpe"], cagr_hold=sh["cagr"],
               alpha=a_ann, alpha_t=a_t, beta=beta, turnover=turnover, cost_yr=cost_yr,
               importance=dict(sorted(((k, round(v, 4)) for k, v in imp.items()), key=lambda kv: -kv[1])), signs=sign,
               curve=[[t.strftime("%Y-%m"), round(float(v), 4)] for t, v in eq.items()], holdout_from=str(pd.Timestamp(hold_start).date()),
               n_obs=int(len(pred)), years=round(len(port) / 252, 1))
    fails = []
    if res["ic"] <= 0:
        fails.append(f"no out-of-sample skill (IC {res['ic']:+.3f})")
    elif t_dev < need:
        fails.append(f"IC not significant enough (t={t_dev:.2f}, need {need:.2f} after {n_tests} models)")
    if perm > 0.05:
        fails.append(f"doesn't beat randomly shifted forecasts (p={perm:.2f})")
    if sd["sharpe"] < 0.4:
        fails.append(f"portfolio Sharpe {sd['sharpe']:.2f} after costs (need 0.4)")
    if a_t < 2.0:
        fails.append(f"alpha vs buy-and-hold not significant (t={a_t:.1f})")
    if pos_years < 0.6:
        fails.append(f"IC positive in only {pos_years:.0%} of years")
    if not fails and (res["ic_hold"] <= 0 or sh["sharpe"] <= 0):
        fails.append(f"failed the sealed 2-year holdout (IC {res['ic_hold']:+.3f}, Sharpe {sh['sharpe']:.2f})")
    res["passed"] = not fails
    res["why"] = "; ".join(fails) if fails else (f"IC {res['ic']:+.3f} (t={t_dev:.1f}), holdout IC {res['ic_hold']:+.3f}, Sharpe {sd['sharpe']:.2f} "
                                                 f"(holdout {sh['sharpe']:.2f}), alpha t={a_t:.1f}, p={perm:.2f}")
    return res, final, pred
