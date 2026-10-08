"""The lego kit. Agents invent NEW kinds of strategies by snapping together building blocks, instead of only
re-tuning the three classic families. A "custom" strategy is 1-3 rules that must ALL be true to enter (longs use each
rule's bullish side, shorts the bearish mirror), plus the usual stop / trailing stop / holding period.

Every block is vetted code with safe parameter ranges, so an invented strategy can always be backtested and no
AI-written code ever runs. New blocks get added here when the team asks for them (tool requests on the Wire)."""
import numpy as np
import pandas as pd

MAX_RULES = 3

# block -> (description template, {param: (min, max, default)})
BLOCKS = {
    "trend":       ("close above/below its {n}-day average", {"n": (20, 250, 100)}),
    "ma_cross":    ("{fast}-day EMA above/below the {slow}-day EMA", {"fast": (5, 60, 20), "slow": (20, 250, 100)}),
    "momentum":    ("{n}-day return beyond {x:.0%}", {"n": (5, 252, 63), "x": (0.0, 0.3, 0.02)}),
    "new_high":    ("close at a new {n}-day high/low", {"n": (10, 252, 55)}),
    "dip":         ("{n}-day z-score stretched past {x:.1f}", {"n": (5, 60, 20), "x": (1.0, 3.5, 2.0)}),
    "rsi_extreme": ("{n}-day RSI oversold below {x:.0f} (mirror for shorts)", {"n": (2, 20, 3), "x": (5, 40, 15)}),
    "rsi_strong":  ("{n}-day RSI strong above {x:.0f} (mirror for shorts)", {"n": (5, 30, 14), "x": (50, 80, 60)}),
    "streak":      ("{n}+ down days in a row (up days for shorts)", {"n": (2, 7, 3)}),
    "range_pos":   ("close in the bottom {x:.0%} of its {n}-day range (top for shorts)", {"n": (10, 120, 20), "x": (0.05, 0.5, 0.2)}),
    "calm":        ("volatility rank between {lo:.0%} and {hi:.0%}", {"lo": (0.0, 1.0, 0.0), "hi": (0.0, 1.0, 0.6)}),
    "gap":         ("gapped down/up more than {x:.1%} at the open", {"x": (0.002, 0.06, 0.01)}),
    "pullback":    ("{n}-day return against a {trend}-day trend", {"n": (2, 20, 5), "trend": (50, 250, 200)}),
}
INT_KEYS = {"n", "fast", "slow", "trend"}
PARAM_KEYS = sorted({k for _, ps in BLOCKS.values() for k in ps})


def clean_rules(rules, allow_empty=False) -> list:
    """Clamp invented rules into the safe ranges. Unknown blocks are dropped; at most MAX_RULES; no duplicates."""
    out, seen = [], set()
    for r in rules or []:
        if not isinstance(r, dict) or r.get("block") not in BLOCKS or r["block"] in seen:
            continue
        b = r["block"]
        seen.add(b)
        src = r.get("params") if isinstance(r.get("params"), dict) else r
        p = {}
        for k, (lo, hi, d) in BLOCKS[b][1].items():
            try:
                v = float(src.get(k, d))
            except (TypeError, ValueError):
                v = d
            v = max(lo, min(hi, v))
            p[k] = int(round(v)) if k in INT_KEYS else round(v, 4)
        if b == "ma_cross" and p["fast"] >= p["slow"]:
            p["fast"], p["slow"] = min(p["fast"], p["slow"] - 5), max(p["slow"], p["fast"] + 5)
        if b == "calm" and p["lo"] > p["hi"]:
            p["lo"], p["hi"] = p["hi"], p["lo"]
        out.append(dict(block=b, params=p))
        if len(out) >= MAX_RULES:
            break
    return out if (out or allow_empty) else [dict(block="momentum", params={"n": 63, "x": 0.02})]


def describe_rules(rules) -> str:
    return " AND ".join(BLOCKS[r["block"]][0].format(**r["params"]) for r in rules)


def _rsi(c, n):
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def rule_masks(df: pd.DataFrame, block: str, p: dict, vol_rank: pd.Series) -> tuple[pd.Series, pd.Series]:
    """(long_ok, short_ok) for every bar."""
    o, h, l, c = df["Open"], df["High"], df["Low"], df["Close"]
    if block == "trend":
        ma = c.rolling(p["n"]).mean()
        return c > ma, c < ma
    if block == "ma_cross":
        f, s = c.ewm(span=p["fast"], adjust=False).mean(), c.ewm(span=p["slow"], adjust=False).mean()
        return f > s, f < s
    if block == "momentum":
        r = c / c.shift(p["n"]) - 1
        return r > p["x"], r < -p["x"]
    if block == "new_high":
        return c > h.rolling(p["n"]).max().shift(1), c < l.rolling(p["n"]).min().shift(1)
    if block == "dip":
        z = (c - c.rolling(p["n"]).mean()) / c.rolling(p["n"]).std().replace(0, np.nan)
        return z < -p["x"], z > p["x"]
    if block == "rsi_extreme":
        r = _rsi(c, p["n"])
        return r < p["x"], r > 100 - p["x"]
    if block == "rsi_strong":
        r = _rsi(c, p["n"])
        return r > p["x"], r < 100 - p["x"]
    if block == "streak":
        down, up = (c < c.shift()).astype(int), (c > c.shift()).astype(int)
        return down.rolling(p["n"]).sum() >= p["n"], up.rolling(p["n"]).sum() >= p["n"]
    if block == "range_pos":
        hi, lo = h.rolling(p["n"]).max(), l.rolling(p["n"]).min()
        pos = (c - lo) / (hi - lo).replace(0, np.nan)
        return pos < p["x"], pos > 1 - p["x"]
    if block == "calm":
        ok = (vol_rank >= p["lo"]) & (vol_rank <= p["hi"])
        return ok, ok
    if block == "gap":
        g = o / c.shift() - 1
        return g < -p["x"], g > p["x"]
    if block == "pullback":
        ma, r = c.rolling(p["trend"]).mean(), c / c.shift(p["n"]) - 1
        return (c > ma) & (r < 0), (c < ma) & (r > 0)
    raise ValueError(block)


def custom_state(df: pd.DataFrame, p: dict, vol_rank: pd.Series) -> tuple[pd.Series, pd.Series]:
    long = pd.Series(True, index=df.index)
    short = pd.Series(True, index=df.index)
    for r in p.get("rules") or []:
        lo, sh = rule_masks(df, r["block"], r["params"], vol_rank)
        long &= lo.fillna(False)
        short &= sh.fillna(False)
    return long, short


def block_schema():
    """JSON schema for one invented rule (all block params optional; unused ones are ignored)."""
    return {"type": "object", "properties": {
        "block": {"type": "string", "enum": list(BLOCKS)},
        **{k: {"type": "number"} for k in PARAM_KEYS}},
        "required": ["block"], "additionalProperties": False}


def catalog() -> str:
    return "\n".join(f"- {b}: {d.split('{')[0].strip() or b} | params " +
                     ", ".join(f"{k}={lo}..{hi}" for k, (lo, hi, _) in ps.items()) + f"  ({d})"
                     for b, (d, ps) in BLOCKS.items())
