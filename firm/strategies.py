"""Strategy library. Every quant on the floor (Mo, Rita, and anyone Ava hires) is one of these
families plus a set of parameters. Ava can only propose these families, with parameters inside
SAFE ranges, so the backtester can always test them and no generated code ever runs."""
import numpy as np
import pandas as pd

from .blocks import clean_rules, describe_rules, custom_state

# family -> {param: (min, max, default)}; strings use a list of choices instead
FAMILIES = {
    "breakout": {  # buy new highs / sell new lows, with a trend filter
        "entry_len": (10, 96, 20), "trend_len": (20, 200, 50),
        "vol_min": (0.0, 1.0, 0.0), "vol_max": (0.0, 1.0, 1.0),
        "direction": (["both", "long", "short"], "both"),
        "stop_atr": (1.0, 4.0, 2.0), "trail_atr": (1.5, 6.0, 3.0), "max_bars": (8, 192, 96),
    },
    "meanrev": {  # fade stretched moves back toward the average
        "z_len": (10, 96, 20), "z_entry": (1.5, 3.5, 2.0),
        "trend_filter": (["none", "with_trend"], "none"), "trend_len": (20, 200, 100),
        "vol_min": (0.0, 1.0, 0.0), "vol_max": (0.0, 1.0, 1.0),
        "direction": (["both", "long", "short"], "both"),
        "stop_atr": (1.0, 4.0, 2.0), "trail_atr": (1.5, 6.0, 3.0), "max_bars": (4, 96, 24),
        "exit_mid": ([True, False], True),
    },
    "tsmom": {  # time-series momentum: go with the sign of the return over a lookback
        "lookback": (8, 288, 96), "threshold": (0.0, 0.05, 0.005),
        "vol_min": (0.0, 1.0, 0.0), "vol_max": (0.0, 1.0, 1.0),
        "direction": (["both", "long", "short"], "both"),
        "stop_atr": (1.0, 4.0, 2.5), "trail_atr": (1.5, 6.0, 4.0), "max_bars": (8, 288, 96),
    },
    "model": {  # a forecasting model from the Model Lab (firm/quant): trades its out-of-sample forecasts
        "direction": (["both", "long", "short"], "both"), "q": (0.05, 0.45, 0.2),
        "stop_atr": (1.0, 4.0, 2.5), "trail_atr": (1.5, 6.0, 3.5), "max_bars": (1, 63, 5),
    },
    "custom": {  # invented by the team from the lego kit (firm/blocks.py): 1-3 rules that must all agree
        "direction": (["both", "long", "short"], "long"),
        "stop_atr": (1.0, 4.0, 2.5), "trail_atr": (1.5, 6.0, 3.5), "max_bars": (3, 120, 20),
    },
}
INT_PARAMS = {"entry_len", "trend_len", "z_len", "lookback", "max_bars"}

DESCRIBE = {
    "breakout": lambda p: f"breakout {p['entry_len']}-bar high/low, trend EMA{p['trend_len']}",
    "meanrev": lambda p: f"fade {p['z_entry']:.1f} std moves ({p['z_len']} bars){', with trend' if p['trend_filter'] == 'with_trend' else ''}",
    "tsmom": lambda p: f"{p['lookback']}-bar momentum > {p['threshold']:.1%}",
    "custom": lambda p: describe_rules(p["rules"]),
    "model": lambda p: _model_desc(p),
}


def _model_desc(p):
    from .quant.registry import describe as d
    return d(p)


def clean(family: str, params: dict) -> dict:
    """Clamp a proposal into the safe ranges, fill defaults. Raises on unknown family."""
    spec = FAMILIES[family]
    out = {}
    for k, rule in spec.items():
        v = params.get(k)
        if isinstance(rule[0], list):
            choices, default = rule
            out[k] = v if v in choices else default
        else:
            lo, hi, default = rule
            try:
                v = float(v)
            except (TypeError, ValueError):
                v = default
            v = max(lo, min(hi, v))
            out[k] = int(round(v)) if k in INT_PARAMS else round(v, 4)
    if family == "custom":
        out["rules"] = clean_rules(params.get("rules"))
    elif family == "model":
        out["model"] = str(params.get("model", ""))[:40]
    elif params.get("extra"):   # extra entry filters a PM added to a classic family through trial and error
        out["extra"] = clean_rules(params["extra"], allow_empty=True)[:2]
    if out.get("vol_min", 0) > out.get("vol_max", 1):
        out["vol_min"], out["vol_max"] = out["vol_max"], out["vol_min"]
    return out


def describe(family, params):
    d = DESCRIBE[family](params)
    if params.get("extra"):
        d += " + only when " + describe_rules(params["extra"])
    if params.get("vol_min", 0) > 0 or params.get("vol_max", 1) < 1:
        d += f", vol rank {params['vol_min']:.0%}-{params['vol_max']:.0%}"
    if params.get("direction", "both") != "both":
        d += f", {params['direction']} only"
    return d


def features(df: pd.DataFrame, family: str, p: dict) -> pd.DataFrame:
    h, l, c = df["High"], df["Low"], df["Close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    f = pd.DataFrame(index=df.index)
    f["atr"] = tr.ewm(alpha=1 / 14, adjust=False).mean()
    f["vol_rank"] = f["atr"].rolling(100, min_periods=30).rank(pct=True)
    if family == "breakout":
        f["hh"] = h.rolling(p["entry_len"]).max().shift(1)
        f["ll"] = l.rolling(p["entry_len"]).min().shift(1)
        f["ema"] = c.ewm(span=p["trend_len"], adjust=False).mean()
    elif family == "meanrev":
        m, s = c.rolling(p["z_len"]).mean(), c.rolling(p["z_len"]).std()
        f["z"] = (c - m) / s.replace(0, np.nan)
        f["ema"] = c.ewm(span=p["trend_len"], adjust=False).mean()
    elif family == "tsmom":
        f["ret"] = c / c.shift(p["lookback"]) - 1
    return f


def state(df: pd.DataFrame, family: str, p: dict, f: pd.DataFrame | None = None) -> pd.Series:
    """+1 / -1 / 0 for every bar: what this strategy wants on that bar's close."""
    f = features(df, family, p) if f is None else f
    c = df["Close"]
    if family == "breakout":
        long = (c > f["hh"]) & (c > f["ema"])
        short = (c < f["ll"]) & (c < f["ema"])
    elif family == "meanrev":
        long, short = f["z"] < -p["z_entry"], f["z"] > p["z_entry"]
        if p["trend_filter"] == "with_trend":
            long &= c > f["ema"]
            short &= c < f["ema"]
    elif family == "custom":
        long, short = custom_state(df, p, f["vol_rank"].fillna(0.5))
    elif family == "model":
        from .quant.registry import state as model_state
        long, short = model_state(df, p)
    else:  # tsmom
        long, short = f["ret"] > p["threshold"], f["ret"] < -p["threshold"]
    vr = f["vol_rank"].fillna(0.5)
    ok = (vr >= p.get("vol_min", 0)) & (vr <= p.get("vol_max", 1))
    if p.get("extra"):
        el, es = custom_state(df, {"rules": p["extra"]}, vr)
        long, short = long & el, short & es
    if p.get("direction") == "long":
        short = short & False
    if p.get("direction") == "short":
        long = long & False
    s = pd.Series(0, index=df.index)
    s[long & ok] = 1
    s[short & ok] = -1
    return s


def events(s: pd.Series) -> pd.Series:
    """A new call only when the wanted direction changes to non-zero (no repeating the same call every bar)."""
    return s.where((s != 0) & (s != s.shift(1).fillna(0)), 0)


def live_call(df: pd.DataFrame, family: str, p: dict) -> tuple[int, dict]:
    """The call on the latest completed bar (0 if nothing new) + a few numbers for the chat."""
    f = features(df, family, p)
    ev = events(state(df, family, p, f))
    last = f.iloc[-1]
    info = {"atr": float(last["atr"]), "vol_rank": float(last["vol_rank"]) if not np.isnan(last["vol_rank"]) else 0.5}
    if family == "meanrev":
        info["z"] = float(last["z"]) if not np.isnan(last["z"]) else 0.0
    if family == "tsmom":
        info["ret"] = float(last["ret"]) if not np.isnan(last["ret"]) else 0.0
    return int(ev.iloc[-1]), info


FOUNDERS = [
    dict(id="mo", name="Mo", family="breakout", founder=True,
         params=clean("breakout", {"entry_len": 20, "trend_len": 50})),
    dict(id="rita", name="Rita", family="meanrev", founder=True,
         params=clean("meanrev", {"z_len": 20, "z_entry": 2.0, "trend_filter": "none", "exit_mid": True})),
]
