"""Overfitting checks and alternate market histories (tools 5-6 of the Quant Toolbox).

5a. Deflated Sharpe ratio (Bailey & Lopez de Prado, 2014). The more ideas the lab tests, the higher the best Sharpe
    gets by pure luck. DSR = the probability that a strategy's Sharpe beats the best Sharpe you'd expect from that many
    worthless ideas, corrected for skew and fat tails. Inputs: the pod's monthly returns, the number of ideas the lab
    has tested, and how much the tested ideas' Sharpes vary.
5b. Probability of backtest overfitting (Bailey, Borwein, Lopez de Prado & Zhu, 2015), CSCV method: take every idea the
    lab has tested, cut 10 years into 8 blocks, and for each of the 70 ways to pick 4 blocks as "in sample": find the
    best idea in sample and check where it ranks out of sample. PBO = how often the in-sample winner lands BELOW the
    median out of sample. Low = picking winners works; ~50%+ = the lab is mostly picking luck.
6.  Alternate histories: the real market history, reshuffled in 3-month blocks (all markets cut at the same calendar
    windows, so crashes still hit everything at once). Each pod's exact strategy is re-run on K made-up decades. An
    edge that only exists in the one path history happened to take shows up as failing in many alternate worlds.
    Caveat: trends longer than a block get broken up, so slow trend followers look a bit worse here than they are."""
import math
from itertools import combinations
from statistics import NormalDist

import numpy as np
import pandas as pd

from .backtest import evaluate_daily
from . import config as C

EULER = 0.5772156649
N01 = NormalDist()
CSCV_BLOCKS = 8
WORLDS = 16
BLOCK_DAYS = 63           # ~3 months of trading days per reshuffled block


def sharpe(r):
    r = np.asarray(r, float)
    return float(r.mean() / r.std(ddof=1)) if len(r) > 2 and r.std(ddof=1) > 0 else 0.0


def deflated_sharpe(monthly, n_trials, var_sr):
    """Probability that the (monthly) Sharpe is real after n_trials ideas. Returns (dsr, sr, sr0)."""
    r = np.asarray(monthly, float)
    r = r[~np.isnan(r)]
    T = len(r)
    if T < 24 or r.std(ddof=1) == 0:
        return None, 0.0, 0.0
    sr = sharpe(r)
    z = (r - r.mean()) / r.std(ddof=0)
    skew, kurt = float((z ** 3).mean()), float((z ** 4).mean())
    n = max(2, int(n_trials))
    sr0 = math.sqrt(max(var_sr, 0.0)) * ((1 - EULER) * N01.inv_cdf(1 - 1 / n) + EULER * N01.inv_cdf(1 - 1 / (n * math.e)))
    den = 1 - skew * sr + (kurt - 1) / 4 * sr ** 2
    if den <= 0:
        return None, sr, sr0
    return float(N01.cdf((sr - sr0) * math.sqrt(T - 1) / math.sqrt(den))), sr, sr0


def pbo_cscv(M, blocks=CSCV_BLOCKS):
    """M: T x N matrix of returns (rows = months, cols = strategies tried). Returns (pbo, n_splits, median logit)."""
    M = np.asarray(M, float)
    T, N = M.shape
    if N < 4 or T < blocks * 4:
        return None, 0, None
    T = T - T % blocks
    parts = np.array_split(np.arange(T), blocks)
    lam = []
    for ins in combinations(range(blocks), blocks // 2):
        i_rows = np.concatenate([parts[k] for k in ins])
        o_rows = np.concatenate([parts[k] for k in range(blocks) if k not in ins])
        def srs(rows):
            X = M[rows]
            sd = X.std(axis=0, ddof=1)
            return np.where(sd > 0, X.mean(axis=0) / np.where(sd > 0, sd, 1), -np.inf)
        best = int(np.argmax(srs(i_rows)))
        oos = srs(o_rows)
        rank = float((oos < oos[best]).sum() + 1)          # 1 = worst ... N = best
        w = rank / (N + 1)
        lam.append(math.log(w / (1 - w)))
    lam = np.array(lam)
    return float((lam <= 0).mean()), len(lam), float(np.median(lam))


def _naive_index(df):
    idx = pd.DatetimeIndex(df.index)
    return idx.tz_convert("America/New_York").tz_localize(None) if idx.tz is not None else idx


def alternate_worlds(daily, k=WORLDS, block=BLOCK_DAYS, seed=7):
    """K synthetic daily histories for every market: real bars, reshuffled in calendar blocks shared by all markets."""
    ref = daily.get("SPY")
    if ref is None or len(ref) < block * 4:
        return []
    ref_idx = _naive_index(ref)
    rng = np.random.default_rng(seed)
    rel = {}
    for sym, df in daily.items():
        idx = _naive_index(df)
        c = df["Close"].to_numpy(float)
        prev = np.r_[np.nan, c[:-1]]
        r = np.column_stack([df["Open"].to_numpy(float) / prev, df["High"].to_numpy(float) / prev, df["Low"].to_numpy(float) / prev, c / prev])
        rel[sym] = (idx, r, float(c[0]), C.INST.get(sym, {}).get("cls") == "crypto")
    worlds = []
    nb = len(ref_idx) // block + 1
    ref_ns = ref_idx.asi8
    ns = {sym: v[0].asi8 for sym, v in rel.items()}                 # integer timestamps: fast searchsorted
    for _ in range(k):
        starts = rng.integers(1, len(ref_idx) - block, size=nb)
        lo, hi = ref_ns[starts], ref_ns[starts + block]
        world = {}
        for sym, (idx, r, c0, crypto) in rel.items():
            i0, i1 = np.searchsorted(ns[sym], lo), np.searchsorted(ns[sym], hi)
            R = np.concatenate([r[a:b] for a, b in zip(i0, i1)]) if len(i0) else np.empty((0, 4))
            R = R[np.isfinite(R).all(axis=1) & (R > 0).all(axis=1)]
            if len(R) < 300:
                continue
            close = c0 * np.cumprod(R[:, 3])
            prev = np.r_[c0, close[:-1]]
            o, h, l = prev * R[:, 0], prev * R[:, 1], prev * R[:, 2]
            h, l = np.maximum.reduce([h, o, close]), np.minimum.reduce([l, o, close])
            index = pd.date_range(idx[0], periods=len(R) if crypto else int(len(R) * 1.45) + 10, freq="D")
            if not crypto:                                   # weekdays only (freq="B" is ~100x slower to build)
                index = index[index.weekday < 5][:len(R)]
            world[sym] = pd.DataFrame({"Open": o, "High": h, "Low": l, "Close": close}, index=index)
        worlds.append(world)
    return worlds


def world_test(worlds, family, params, markets):
    """Re-run one strategy on every alternate world: share of worlds profitable, median / 10th-percentile PF."""
    pfs, cagrs = [], []
    for w in worlds:
        res = evaluate_daily(w, family, params, [m for m in markets if m in w])
        if res["all"]["n"] < 10:
            continue
        pfs.append(res["all"]["pf"])
        cagrs.append(res.get("cagr", 0.0))
    if not pfs:
        return None
    pfs = np.array(pfs)
    return dict(k=len(pfs), profitable=float((pfs > 1.0).mean()), pf_med=round(float(np.median(pfs)), 2),
                pf_p10=round(float(np.percentile(pfs, 10)), 2), cagr_med=round(float(np.median(cagrs)), 4))
