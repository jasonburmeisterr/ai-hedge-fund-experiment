"""Monte Carlo risk lab: how much should a pod risk per trade?

Answered by simulation instead of gut feel:
  1. take the pod's trades (10+ years of backtest with a haircut, blended with its live paper trades as they come in)
  2. replay them in random order thousands of times, in BLOCKS of consecutive trades so losing streaks that come in
     clusters (crashes, regime changes) stay clustered, sized at a candidate risk per trade with the same position cap
     as the live floor
  3. for every candidate risk level, measure the chance of hitting the pod's drawdown stop within a year, the median
     and bad-case (5th percentile) return, the typical worst drawdown, and long-run growth (mean log return)
Growth peaks at the Kelly risk. Betting MORE than Kelly makes less money with far deeper drawdowns, so the CIO bets a
fraction of Kelly (the risk appetite) and never past the ruin limit.
Limits: trades are compounded one after another, so several positions losing on the same day only show up through the
block structure; a live book can be worse than any history."""
import numpy as np

GRID = np.array([0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.10, 0.12, 0.15, 0.20])
PATHS = 3000
BLOCK = 8


def block_paths(n_pool, n_trades, paths, block, rng):
    """Circular block bootstrap: each path is runs of `block` consecutive trades from random starting points."""
    block = max(1, min(block, n_pool))
    nb = -(-n_trades // block)
    starts = rng.integers(0, n_pool, size=(paths, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n_pool
    return idx.reshape(paths, -1)[:, :n_trades]


def simulate(R, sf, risk, cap, dd_limit, idx):
    """R: each trade's R-multiple net of costs. sf: its stop distance as a fraction of price. cap: max position size in
    units of pod capital. A position is min(risk / sf, cap) of pod capital, so the trade returns min(risk, cap * sf) x R."""
    r = np.maximum(np.minimum(risk, cap * sf)[idx] * R[idx], -0.95)
    eq = np.cumprod(1 + r, axis=1)
    peak = np.maximum.accumulate(np.maximum(eq, 1.0), axis=1)
    dd = (eq / peak - 1).min(axis=1)
    fin = eq[:, -1]
    return dict(risk=float(risk), p_ruin=float((dd <= -dd_limit).mean()), p_loss=float((fin < 1).mean()),
                ret_med=float(np.median(fin) - 1), ret_p5=float(np.percentile(fin, 5) - 1), ret_p95=float(np.percentile(fin, 95) - 1),
                dd_med=float(np.median(dd)), dd_p5=float(np.percentile(dd, 5)), growth=float(np.log(np.maximum(fin, 1e-9)).mean()))


def risk_curve(R, sf, cap, n_trades, dd_limit, seed=7):
    """The same random paths for every risk level (common random numbers), so the curve is smooth and comparable."""
    R, sf = np.asarray(R, float), np.asarray(sf, float)
    idx = block_paths(len(R), max(1, int(n_trades)), PATHS, BLOCK, np.random.default_rng(seed))
    return [simulate(R, sf, f, cap, dd_limit, idx) for f in GRID]


def point(R, sf, cap, n_trades, dd_limit, risk, seed=7):
    """The simulation at one exact risk level, on the same paths as risk_curve."""
    R, sf = np.asarray(R, float), np.asarray(sf, float)
    idx = block_paths(len(R), max(1, int(n_trades)), PATHS, BLOCK, np.random.default_rng(seed))
    return simulate(R, sf, risk, cap, dd_limit, idx)


def choose(curve, appetite, ruin_tol, lo, hi):
    """Pick the risk per trade: appetite x Kelly, never where P(hitting the drawdown stop in a year) > ruin_tol.
    Returns (risk, kelly risk, the binding reason)."""
    best = max(curve, key=lambda c: c["growth"])
    if best["growth"] <= 0:
        return lo, 0.0, "no edge left after the haircut: minimum size"
    kelly = best["risk"]
    target = appetite * kelly
    safe = max((c["risk"] for c in curve if c["p_ruin"] <= ruin_tol), default=lo)
    risk, why = (target, f"{appetite:.0%} of Kelly ({kelly:.1%})") if target <= safe else (safe, f"ruin limit: {ruin_tol:.0%} chance of a stop-out in a year")
    if risk > hi:
        risk, why = hi, f"CIO ceiling ({hi:.1%})"
    if risk < lo:
        risk, why = lo, "minimum size"
    return float(risk), float(kelly), why


def at(curve, risk):
    """The curve row closest to a risk level."""
    return min(curve, key=lambda c: abs(c["risk"] - risk))
