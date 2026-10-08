"""Volatility models: what options desks actually run.

Forecast: HAR-RV (Corsi 2009), the workhorse realized-volatility model. The log of next month's realized vol is
regressed on the log of yesterday's, last week's and last month's realized vol (Garman-Klass, from daily OHLC) plus the
log of implied vol (HAR-IV: the options market's own forecast usually adds information). Refit every quarter on an
expanding window; scored out of sample against two simple forecasts: last month's realized vol, and implied vol itself.

Trade: the volatility risk premium. Implied vol is usually ABOVE the volatility that follows (option buyers pay for
insurance), so a seller of options earns it on average and gets hurt in crashes. The model's job is timing: sell only
when implied vol is rich versus the FORECAST (IV / forecast >= k), stand aside when it isn't.

Backtest (honest about its limits): every 5 trading days, a 30-day iron condor (short 20-delta call and put, long
7-delta wings) is priced with Black-Scholes at that day's implied vol with a skew adjustment, charged 6% of premium in
bid-ask costs each way, marked daily at each day's implied vol, and managed with Opal's live rules: take profit at 50%
of the credit, stop at a loss of 1.5x the credit, close a day before expiry. P&L in R (multiples of the max loss).
Three versions per market: ALWAYS sell (the baseline: what the premium alone pays), NAIVE (IV / last month's realized
vol >= 1.2, Opal's old rule) and MODEL (IV / HAR forecast >= k, with k chosen on the development years only).
The last 2 years are a sealed holdout."""
import math
from statistics import NormalDist

import numpy as np
import pandas as pd

from .features import gk_var, _naive
from .validate import nw_t

N = NormalDist()
HOLD_TD, HOLD_CAL, EVERY = 21, 30, 5
SHORT_D, WING_D = 0.20, 0.07
COST = 0.06
TP, SL = 0.5, 1.5
KS = (1.0, 1.1, 1.2, 1.3, 1.4)
HOLDOUT = 504
SKEW = {"equity": dict(sp=1.15, lp=1.28, sc=0.95, lc=0.97), "crypto": dict(sp=1.05, lp=1.12, sc=1.03, lc=1.08)}


def bs(S, K, T, iv, kind):
    if T <= 1e-6:
        return max(0.0, S - K) if kind == "C" else max(0.0, K - S)
    iv = max(iv, 1e-4)
    d1 = (math.log(S / K) + 0.5 * iv * iv * T) / (iv * math.sqrt(T))
    d2 = d1 - iv * math.sqrt(T)
    return S * N.cdf(d1) - K * N.cdf(d2) if kind == "C" else K * N.cdf(-d2) - S * N.cdf(-d1)


def strike(S, iv, T, delta, kind):
    """Strike with the given absolute delta (r = 0)."""
    d1 = N.inv_cdf(delta) if kind == "C" else N.inv_cdf(1 - delta)
    return S * math.exp(-d1 * iv * math.sqrt(T) + 0.5 * iv * iv * T)


def har(df, iv=None):
    """Walk-forward HAR(-IV) forecasts of next-month realized vol. Returns DataFrame: rv_m, rv_fwd, fc, iv (annualized)."""
    df = _naive(df)
    v = gk_var(df)
    d = pd.DataFrame(index=df.index)
    d["rv_d"] = np.sqrt(v.rolling(1).mean() * 252)
    d["rv_w"] = np.sqrt(v.rolling(5).mean() * 252)
    d["rv_m"] = np.sqrt(v.rolling(22).mean() * 252)
    d["rv_fwd"] = np.sqrt(v[::-1].rolling(HOLD_TD).mean()[::-1].shift(-1) * 252)
    if iv is not None:
        d["iv"] = iv.reindex(d.index).ffill(limit=3)
    cols = ["rv_d", "rv_w", "rv_m"] + (["iv"] if iv is not None else [])
    L = np.log(d[cols + ["rv_fwd"]].clip(lower=0.01))
    ok_x = L[cols].notna().all(axis=1)
    fc = np.full(len(d), np.nan)
    dates = d.index
    start = 504
    for i in range(start, len(dates), 63):
        cut = max(0, i - HOLD_TD - 1)                         # purge: training targets must end before the block starts
        tr = (np.arange(len(dates)) < cut) & ok_x.values & L["rv_fwd"].notna().values
        te = (np.arange(len(dates)) >= i) & (np.arange(len(dates)) < i + 63) & ok_x.values
        if tr.sum() < 250 or not te.any():
            continue
        A = np.column_stack([np.ones(tr.sum()), L[cols].values[tr]])
        beta, *_ = np.linalg.lstsq(A, L["rv_fwd"].values[tr], rcond=None)
        resid = L["rv_fwd"].values[tr] - A @ beta
        B = np.column_stack([np.ones(te.sum()), L[cols].values[te]])
        fc[te] = np.exp(B @ beta + 0.5 * resid.var())
    d["fc"] = pd.Series(fc, index=d.index)
    d["Close"] = df["Close"]
    return d


def forecast_quality(d, hold_from):
    """Out-of-sample MSE of log vol: HAR vs last month's realized vol vs implied vol (lower is better)."""
    x = d.dropna(subset=["fc", "rv_fwd", "rv_m"])
    def mse(col, sub):
        return float(np.mean((np.log(sub[col]) - np.log(sub["rv_fwd"])) ** 2)) if len(sub) else None
    out = {}
    for name, sub in (("dev", x[x.index < hold_from]), ("holdout", x[x.index >= hold_from])):
        m = dict(har=mse("fc", sub), naive=mse("rv_m", sub))
        if "iv" in sub and sub["iv"].notna().sum() > 50:
            m["iv"] = mse("iv", sub.dropna(subset=["iv"]))
            m["iv_premium"] = float((sub["iv"] - sub["rv_fwd"]).mean())        # average implied minus realized (the premium)
        out[name] = m
    return out


def condor_trade(d, i, kind):
    """Open a 30-day iron condor on row i, manage it daily, return R (P&L / max loss)."""
    sk = SKEW[kind]
    S0, iv0 = d["Close"].iat[i], d["iv"].iat[i]
    T0 = HOLD_CAL / 365
    Kc, Kp = strike(S0, iv0, T0, SHORT_D, "C"), strike(S0, iv0, T0, SHORT_D, "P")
    Kcw, Kpw = strike(S0, iv0, T0, WING_D, "C"), strike(S0, iv0, T0, WING_D, "P")
    def value(S, iv, T):          # cost to buy the condor back (what the short position owes)
        return (bs(S, Kc, T, iv * sk["sc"], "C") - bs(S, Kcw, T, iv * sk["lc"], "C")
                + bs(S, Kp, T, iv * sk["sp"], "P") - bs(S, Kpw, T, iv * sk["lp"], "P"))
    gross = value(S0, iv0, T0)
    if gross <= 0:
        return None
    credit = gross * (1 - COST)
    max_loss = max(Kcw - Kc, Kp - Kpw) - credit
    if max_loss <= 0:
        return None
    end = min(i + HOLD_TD, len(d) - 1)
    for j in range(i + 1, end + 1):
        T = max(0.0, T0 - (j - i) * HOLD_CAL / HOLD_TD / 365)
        S, iv = d["Close"].iat[j], d["iv"].iat[j]
        if not np.isfinite(iv):
            iv = iv0
        if j == end:
            v = value(S, iv, 0.0 if j - i >= HOLD_TD else T)
            return (credit - v * (1 + COST if v > 0 else 1)) / max_loss
        v = value(S, iv, T) * (1 + COST)
        if v <= TP * credit or credit - v <= -SL * credit or T * 365 <= 1:
            return (credit - v) / max_loss
    return None


def vrp_backtest(daily_df, iv, kind="equity"):
    """ALWAYS / NAIVE / MODEL iron-condor sellers on one underlying. Returns stats + the chosen k + the latest signal."""
    d = har(daily_df, iv)
    d = d.dropna(subset=["Close", "iv"])
    if len(d) < 800:
        return None
    hold_from = d.index[-HOLDOUT] if len(d) > HOLDOUT + 500 else d.index[-1]
    rows = []
    for i in range(0, len(d) - 2, EVERY):
        if not np.isfinite(d["fc"].iat[i]):
            continue
        r = condor_trade(d, i, kind)
        if r is None:
            continue
        rows.append(dict(t=d.index[i], r=r, ratio=d["iv"].iat[i] / d["fc"].iat[i], naive=d["iv"].iat[i] / d["rv_m"].iat[i]))
    T = pd.DataFrame(rows)
    if T.empty:
        return None
    dev, hold = T[T.t < hold_from], T[T.t >= hold_from]
    def st(x):
        r = x["r"].values
        return dict(n=int(len(r)), avg=float(r.mean()) if len(r) else 0.0, win=float((r > 0).mean()) if len(r) else 0.0,
                    worst=float(r.min()) if len(r) else 0.0, t=nw_t(r, 4) if len(r) > 20 else 0.0)
    best_k, best = None, -9.0
    for k in KS:
        sub = dev[dev.ratio >= k]
        if len(sub) >= 30 and sub["r"].mean() > best:
            best_k, best = k, float(sub["r"].mean())
    out = dict(always=dict(dev=st(dev), hold=st(hold)), naive=dict(dev=st(dev[dev.naive >= 1.2]), hold=st(hold[hold.naive >= 1.2])),
               k=best_k, quality=forecast_quality(d, hold_from), holdout_from=str(pd.Timestamp(hold_from).date()))
    if best_k is not None:
        out["model"] = dict(dev=st(dev[dev.ratio >= best_k]), hold=st(hold[hold.ratio >= best_k]))
    m = out.get("model")
    out["passed"] = bool(m and m["dev"]["avg"] > 0 and m["dev"]["t"] >= 2.0 and m["hold"]["n"] >= 8 and m["hold"]["avg"] > 0
                         and m["dev"]["avg"] >= out["always"]["dev"]["avg"])
    last = d.iloc[-1]
    out["now"] = dict(iv=float(last["iv"]), rv=float(last["rv_m"]), fc=float(last["fc"]) if np.isfinite(last["fc"]) else None,
                      ratio=float(last["iv"] / last["fc"]) if np.isfinite(last["fc"]) and last["fc"] > 0 else None, date=str(d.index[-1].date()))
    out["curve"] = [[str(t.date()), round(float(v), 3)] for t, v in d[["fc"]].dropna().iloc[-260::5]["fc"].items()]
    out["iv_curve"] = [[str(t.date()), round(float(v), 3)] for t, v in d["iv"].iloc[-260::5].items()]
    out["rv_curve"] = [[str(t.date()), round(float(v), 3)] for t, v in d["rv_m"].iloc[-260::5].items()]
    return out


def live_forecast(daily_df, iv):
    """Latest HAR forecast for the live desk (uses the same walk-forward model's latest fit)."""
    d = har(daily_df, iv)
    last = d.dropna(subset=["fc"]).iloc[-1] if d["fc"].notna().any() else None
    return None if last is None else float(last["fc"])
