"""The model registry: every hired model's forecasts, so a model PM trades through the normal pipeline
(strategies.state for family "model" asks here what the model wants on each date for each market).

A model's history = its walk-forward OUT-OF-SAMPLE forecasts (what it would have predicted at the time), extended
day by day with live forecasts from the final model. Trading rule:
  cross_section: long the markets ranked in the top q of the day's forecasts, short the bottom q (if allowed);
  timing: long when the market's forecast z-score (vs its own past forecasts) >= z(1-q), short when <= z(q)."""
import os
import pickle
from statistics import NormalDist

import numpy as np
import pandas as pd

from ..history import CACHE

DIR = os.path.join(CACHE, "models")
MODELS: dict = {}          # id -> {meta: dict, preds: DataFrame (date x sym), final: Model}


def save(mid, meta, preds, final):
    os.makedirs(DIR, exist_ok=True)
    wide = preds.unstack("sym") if isinstance(preds, pd.Series) else preds
    MODELS[mid] = dict(meta=meta, preds=wide.sort_index(), final=final)
    with open(os.path.join(DIR, f"{mid}.pkl"), "wb") as fh:
        pickle.dump(MODELS[mid], fh)


def load(mid):
    if mid in MODELS:
        return MODELS[mid]
    p = os.path.join(DIR, f"{mid}.pkl")
    if os.path.exists(p):
        try:
            with open(p, "rb") as fh:
                MODELS[mid] = pickle.load(fh)
            return MODELS[mid]
        except Exception:
            return None
    return None


def describe(p):
    m = load(p.get("model", ""))
    if not m:
        return f"ML model {p.get('model', '?')} (not loaded)"
    x = m["meta"]
    return (f"ML model \"{x['name']}\": {x['learner']} on {len(x['features'])} features, {x['horizon']}-day forecast, "
            f"{'cross-sectional ranking' if x['style'] == 'cross_section' else 'market timing'}")


def _signal(m, q):
    W = m["preds"]
    if m["meta"]["style"] == "cross_section":
        r = W.rank(axis=1, pct=True)
        cnt = W.notna().sum(axis=1)
        r = r.where(cnt >= 6)
        return (r >= 1 - q), (r <= q)
    mu = W.expanding(60).mean().shift()
    sd = W.expanding(60).std().shift()
    z = (W - mu) / sd
    hi = NormalDist().inv_cdf(1 - q)
    return (z >= hi), (z <= -hi)


def state(df, p):
    """(long, short) boolean Series aligned to df.index for the market p['_sym']."""
    idx = pd.DatetimeIndex(df.index)
    key = idx.tz_localize(None).normalize() if idx.tz is not None else idx.normalize()
    f = pd.Series(False, index=df.index)
    m = load(p.get("model", ""))
    sym = p.get("_sym")
    if not m or sym is None or sym not in m["preds"].columns:
        return f, f.copy()
    L, S = m.get("_sig", (None, None))
    if L is None or m.get("_sig_n") != len(m["preds"]) or m.get("_sig_q") != p.get("q", 0.2):
        L, S = _signal(m, p.get("q", 0.2))
        m["_sig"], m["_sig_n"], m["_sig_q"] = (L, S), len(m["preds"]), p.get("q", 0.2)
    long = pd.Series(L[sym].reindex(key).fillna(False).astype(bool).values, index=df.index)
    short = pd.Series(S[sym].reindex(key).fillna(False).astype(bool).values, index=df.index)
    return long, short


def extend(mid, X):
    """Append live forecasts for dates after the stored history (X: features MultiIndex date x sym, model's columns)."""
    m = load(mid)
    if not m:
        return 0
    W = m["preds"]
    last = W.index.max()
    dates = X.index.get_level_values("date")
    new = X[dates > last]
    if new.empty:
        return 0
    good = new.notna().mean(axis=1) >= 0.7
    new = new[good]
    if new.empty:
        return 0
    pr = pd.Series(m["final"].predict(new.values), index=new.index).unstack("sym")
    m["preds"] = pd.concat([W, pr]).sort_index()
    m["preds"] = m["preds"][~m["preds"].index.duplicated(keep="last")]
    m.pop("_sig", None)
    with open(os.path.join(DIR, f"{mid}.pkl"), "wb") as fh:
        pickle.dump({k: v for k, v in m.items() if not k.startswith("_")}, fh)
    return len(pr)


def latest(mid, n=1):
    m = load(mid)
    if not m:
        return {}
    W = m["preds"].tail(n)
    return {s: float(v) for s, v in W.iloc[-1].dropna().items()} if len(W) else {}
