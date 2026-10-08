"""The backtest machine. Replays a strategy over history with the same sizing, fees and slippage as the
live floor. Data is split: the first 60% is "in-sample", the last 40% is "out-of-sample" (OOS).
An idea only passes if it ALSO works on the OOS part, which protects against curve-fitting."""
import math

import numpy as np
import pandas as pd

from .config import INST, RISK_PER_TRADE, MAX_POS_NOTIONAL, MAX_FUT_LEVERAGE
from .strategies import features, state, events

SPLIT = 0.6


def run_market(df: pd.DataFrame, sym: str, family: str, p: dict, rand=None) -> list[dict]:
    """Simulate one market. Returns the trades (each with % P&L of equity, after costs, and the bar index).
    rand=(rng, entry probability, side mix): replace the strategy's entries with random ones (the null model)."""
    inst = INST[sym]
    if family == "model":
        p = dict(p, _sym=sym)
    f = features(df, family, p)
    ev = events(state(df, family, p, f)).values
    if rand is not None:
        rng, prob, long_share = rand
        ev = np.where(rng.random(len(ev)) < prob, np.where(rng.random(len(ev)) < long_share, 1, -1), 0)
    o, h, l, c = (df[k].values for k in ("Open", "High", "Low", "Close"))
    atr = f["atr"].values
    z = f["z"].values if "z" in f else None
    eq, trades, pos = 1.0, [], None
    warm = 120
    for i in range(warm, len(df)):
        if pos:  # manage the open trade on this bar
            side, entry, stop = pos["side"], pos["entry"], pos["stop"]
            exit_px, why = None, None
            if (l[i] <= stop if side > 0 else h[i] >= stop):
                exit_px, why = (min(o[i], stop) if side > 0 else max(o[i], stop)), "stop"
            elif i - pos["i"] >= p["max_bars"]:
                exit_px, why = c[i], "time"
            elif family == "meanrev" and p.get("exit_mid") and z is not None and not math.isnan(z[i]) and z[i] * side >= 0:
                exit_px, why = c[i], "mean"
            if exit_px is not None:
                fill = exit_px * (1 - inst["slip_pct"] * side)
                notional_frac = pos["frac"]
                gross = (fill / entry - 1) * side * notional_frac
                cost = cost_frac(inst, notional_frac, entry, pos["qty_hint"])
                r = gross - cost
                eq *= 1 + r
                # move / sf / cost (per $ of notional) let the Monte Carlo re-size the same trade at any risk level
                trades.append(dict(i=pos["i"], j=i, ret=r, why=why, side=side, move=(fill / entry - 1) * side, sf=pos["sf"],
                                   cost=cost / notional_frac if notional_frac else 0.0))
                pos = None
            else:  # trail the stop with the close
                best = max(pos["best"], c[i]) if side > 0 else min(pos["best"], c[i])
                pos["best"] = best
                new = best - side * p["trail_atr"] * atr[i]
                if (new - stop) * side > 0:
                    pos["stop"] = new
        if not pos and ev[i - 1] != 0 and not math.isnan(atr[i - 1]) and atr[i - 1] > 0:
            side = int(ev[i - 1])
            if side < 0 and not inst["shorts"]:
                continue
            entry = o[i] * (1 + inst["slip_pct"] * side)
            sd = p["stop_atr"] * atr[i - 1]
            frac = RISK_PER_TRADE * entry / sd            # position size as a fraction of equity
            frac = min(frac, MAX_FUT_LEVERAGE if inst["cls"] == "futures" else MAX_POS_NOTIONAL)
            qty_hint = frac * 100_000 / (entry * inst["pv"])   # contracts on a $100k account (for $ fees)
            pos = dict(side=side, entry=entry, stop=entry - side * sd, best=entry, i=i, frac=frac, qty_hint=qty_hint, sf=sd / entry)
    return trades


def cost_frac(inst, frac, px, qty_hint):
    if "fee_per" in inst:  # $ per contract per side on a $100k account
        return 2 * inst["fee_per"] * max(1.0, round(qty_hint)) / 100_000
    return 2 * inst["fee_pct"] * frac


def stats(trades: list[dict]) -> dict:
    if not trades:
        return dict(n=0, win=0.0, ret=0.0, pf=0.0, avg_bps=0.0, maxdd=0.0)
    r = np.array([t["ret"] for t in trades])
    curve = np.cumprod(1 + r)
    dd = float((curve / np.maximum.accumulate(curve) - 1).min())
    gains, losses = r[r > 0].sum(), -r[r < 0].sum()
    return dict(n=len(r), win=float((r > 0).mean()), ret=float(curve[-1] - 1),
                pf=float(gains / losses) if losses > 0 else (9.99 if gains > 0 else 0.0),
                avg_bps=float(r.mean() * 1e4), maxdd=dd)


def evaluate(history: dict, family: str, p: dict, markets: list[str]) -> dict:
    """Backtest on each market; report in-sample and out-of-sample results, overall and per market."""
    is_all, oos_all, per = [], [], {}
    for sym in markets:
        df = history.get(sym)
        if df is None or len(df) < 400:
            continue
        cut = int(len(df) * SPLIT)
        tr = run_market(df, sym, family, p)
        ins = [t for t in tr if t["i"] < cut]
        oos = [t for t in tr if t["i"] >= cut]
        is_all += ins
        oos_all += oos
        per[sym] = dict(is_=stats(ins), oos=stats(oos))
    return dict(is_=stats(is_all), oos=stats(oos_all), per=per,
                markets=[m for m in markets if m in per])


# The hiring bar. Deliberately strict: most ideas should fail.
GATE = dict(min_oos_trades=15, min_oos_pf=1.15, min_is_pf=1.0)


def verdict(res: dict) -> tuple[bool, str]:
    o, i = res["oos"], res["is_"]
    if o["n"] < GATE["min_oos_trades"]:
        return False, f"too few out-of-sample trades ({o['n']})"
    if i["pf"] < GATE["min_is_pf"]:
        return False, f"loses even in-sample (PF {i['pf']:.2f})"
    if o["pf"] < GATE["min_oos_pf"] or o["ret"] <= 0:
        return False, f"fails out-of-sample (PF {o['pf']:.2f}, {o['ret']:+.1%})"
    pos_mk = sum(1 for v in res["per"].values() if v["oos"]["ret"] > 0)
    if len(res["per"]) >= 3 and pos_mk < len(res["per"]) / 2:
        return False, f"only works in {pos_mk}/{len(res['per'])} markets"
    return True, f"OOS PF {o['pf']:.2f}, {o['ret']:+.1%} over {o['n']} trades"


# ── daily research: years of data, judged much more strictly ──
FOLDS = 4                      # the history is cut into 4 time periods; a strategy must work in most of them
FUND_RISK = 0.005              # for reporting: each trade risks 0.5% of the fund
GATE_D = dict(min_trades=40, min_pf=1.20, min_good_folds=3, max_dd=-0.25, max_corr=0.70)


def required_t(n_tests: int) -> float:
    """Significance bar that rises with the number of ideas already tested (a multiple-testing haircut).
    1 idea -> 1.75, 10 ideas -> 2.4, 50 ideas -> 3.1"""
    return 1.5 + 0.4 * math.log(1 + max(0, n_tests))


def evaluate_daily(history: dict, family: str, p: dict, markets: list[str]) -> dict:
    """Backtest on daily bars, every market on equal capital. Reports pooled trade stats, per-period stats,
    a significance t-stat, the portfolio's monthly returns (for correlation checks) and its max drawdown."""
    rows, used = [], []
    for sym in markets:
        df = history.get(sym)
        if df is None or len(df) < 300:
            continue
        used.append(sym)
        for t in run_market(df, sym, family, p):
            rows.append(dict(ret=t["ret"], exit=df.index[min(t["j"], len(df) - 1)], entry=df.index[t["i"]], side=t["side"], sym=sym,
                             move=t["move"], sf=t["sf"], cost=t["cost"]))
    if not rows:
        return dict(all=stats([]), folds=[], t=0.0, monthly=pd.Series(dtype=float), maxdd=0.0, markets=used, recent=stats([]))
    tr = pd.DataFrame(rows).sort_values("exit")
    start = min(history[s].index[300] for s in used)
    end = max(history[s].index[-1] for s in used)
    edges = pd.date_range(start, end, periods=FOLDS + 1)
    folds = [stats([{"ret": r} for r in tr[(tr.exit >= a) & (tr.exit <= b)].ret]) for a, b in zip(edges[:-1], edges[1:])]
    recent = stats([{"ret": r} for r in tr[tr.exit >= edges[-2]].ret])
    r = tr.ret.values
    t = float(r.mean() / r.std(ddof=1) * math.sqrt(len(r))) if len(r) > 2 and r.std() > 0 else 0.0
    # fund-level returns if every trade risks FUND_RISK of the whole fund (trade returns above are at RISK_PER_TRADE)
    monthly = tr.set_index("exit").ret.resample("ME").sum() * (FUND_RISK / RISK_PER_TRADE)
    curve = (1 + monthly).cumprod()
    maxdd = float((curve / curve.cummax() - 1).min()) if len(curve) else 0.0
    years = max((end - start).days / 365.25, 0.5)
    cagr = float(curve.iloc[-1] ** (1 / years) - 1) if len(curve) else 0.0
    return dict(all=stats([{"ret": x} for x in r]), folds=folds, t=t, monthly=monthly, maxdd=maxdd, cagr=cagr,
                markets=used, recent=recent, years=years, trades=tr,
                bar="hourly" if len(history[used[0]]) / max((history[used[0]].index[-1] - history[used[0]].index[0]).days / 365.25, 0.5) > 600 else "daily")


def random_baseline(history: dict, family: str, p: dict, markets: list[str], res: dict, seeds: int = 4) -> dict:
    """The null model: random entry days on the same markets, same long/short mix and trade count, same exits, costs
    and sizing. A real edge must beat this, not just zero (in a rising market, random longs make money too)."""
    tr = res.get("trades")
    if tr is None or not len(tr):
        return dict(avg=0.0, pf=0.0, n=0)
    bars = sum(len(history[s]) - 120 for s in res["markets"] if s in history)
    prob = min(0.5, 1.6 * len(tr) / max(bars, 1))            # random entries only fire while flat, so over-sample a little
    long_share = float((tr.side > 0).mean())
    rets = []
    for k in range(seeds):
        rng = np.random.default_rng(1000 + k)
        for sym in res["markets"]:
            df = history.get(sym)
            if df is not None and len(df) >= 300:
                rets += [t["ret"] for t in run_market(df, sym, family, p, rand=(rng, prob, long_share))]
    r = np.array(rets)
    if not len(r):
        return dict(avg=0.0, pf=0.0, n=0)
    w, l = r[r > 0].sum(), -r[r < 0].sum()
    return dict(avg=float(r.mean()), pf=float(w / l) if l > 0 else 9.99, n=int(len(r) / seeds))


def beats_random(res: dict, base: dict) -> tuple[bool, float]:
    """t-stat of the strategy's average trade over the random baseline's average trade."""
    r = res["trades"].ret.values if res.get("trades") is not None and len(res["trades"]) else np.array([])
    if len(r) < 10:
        return False, 0.0
    t = (r.mean() - base["avg"]) / (r.std(ddof=1) / math.sqrt(len(r)) or 1e-9)
    return t >= RANDOM_T, float(t)


RANDOM_T = 2.0


def verdict_daily(res: dict, n_tests: int, others: dict | None = None) -> tuple[bool, str]:
    """others: {pod name: monthly return series} of the current team, to reject redundant strategies."""
    a, g = res["all"], GATE_D
    if a["n"] < g["min_trades"]:
        return False, f"too few trades ({a['n']}) to judge"
    if a["pf"] < g["min_pf"]:
        return False, f"profit factor {a['pf']:.2f} after costs (need {g['min_pf']})"
    good = sum(1 for f in res["folds"] if f["n"] and f["pf"] > 1.0)
    if good < g["min_good_folds"]:
        return False, f"only profitable in {good}/{len(res['folds'])} time periods"
    need = required_t(n_tests)
    if res["t"] < need:
        return False, f"not significant enough (t={res['t']:.2f}, need {need:.2f} after {n_tests} ideas tested)"
    if res["maxdd"] < g["max_dd"]:
        return False, f"drawdown too deep ({res['maxdd']:.0%})"
    if res["recent"]["n"] >= 5 and res["recent"]["pf"] < 1.0:
        return False, f"stopped working recently (last-period PF {res['recent']['pf']:.2f})"
    for name, m in (others or {}).items():
        both = pd.concat([res["monthly"], m], axis=1).dropna()
        if len(both) >= 18:
            c = float(both.iloc[:, 0].corr(both.iloc[:, 1]))
            if c > g["max_corr"]:
                return False, f"too similar to {name}'s strategy (correlation {c:.2f})"
    return True, f"PF {a['pf']:.2f}, t={res['t']:.1f}, {good}/{len(res['folds'])} periods profitable, {res['cagr']:+.1%}/yr at 0.5% risk per trade, max DD {res['maxdd']:.0%}"


def _pct(f):
    return f"PF {f['pf']:.2f}" if f["n"] else "n/a"


def fmt_daily(res: dict) -> str:
    a = res["all"]
    return (f"{res.get('years', 0):.0f}y {res.get('bar', 'daily')}, {a['n']} trades, PF {a['pf']:.2f}, win {a['win']:.0%}, t={res['t']:.1f}, "
            f"periods {'/'.join(_pct(f) for f in res['folds'])}, "
            f"{res.get('cagr', 0):+.1%}/yr, maxDD {res['maxdd']:.0%} (0.5% risk/trade)")
