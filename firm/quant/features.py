"""The feature library: vetted, look-ahead-free inputs a model may use (Kai picks from these; no generated code runs).

Every feature on date t uses data up to and including the close of t. Returns are volatility-scaled (a 2% move in bonds
and in bitcoin mean very different things), so one model can be pooled across all markets. Cross-sectional features
rank each market against the others that day. Context features describe the whole market (same value for every
asset that day). Targets: the forward k-day return from the close of t, scaled by the same volatility."""
import numpy as np
import pandas as pd

from .. import config as C

FEATURES = {
    # momentum / trend (volatility-scaled)
    "ret_1": "1-day return / vol", "ret_5": "1-week return / vol", "ret_21": "1-month return / vol",
    "ret_63": "3-month return / vol", "ret_252": "12-month return / vol", "mom_12_1": "12-month momentum skipping the last month / vol",
    "dist_ma50": "distance from the 50-day average / vol", "dist_ma200": "distance from the 200-day average / vol",
    # mean reversion / oscillators
    "z_20": "20-day z-score", "rsi_14": "14-day RSI (centered)", "range_pos_20": "position in the 20-day range (centered)",
    "streak": "consecutive up(+)/down(-) days", "gap": "today's gap at the open / vol", "drawdown_252": "drawdown from the 12-month high / vol",
    # volatility
    "vol_21": "1-month realized vol (log)", "vol_ratio": "1-month / 3-month realized vol (log)", "skew_63": "3-month return skewness",
    "volume_z": "volume vs its 1-month average (z)",
    # cross-sectional (rank vs the other markets that day, -0.5..0.5)
    "xs_mom_63": "3-month momentum rank", "xs_mom_252": "12-month momentum rank", "xs_rev_5": "1-week return rank", "xs_vol": "volatility rank",
    # market context (same for every market that day)
    "mkt_trend": "S&P 500 above its 200-day average", "mkt_ret_21": "S&P 500 1-month return / vol",
    "credit": "high yield vs Treasuries, 3-month change", "vix": "VIX level (log)", "vix_ts": "VIX / VIX3M term structure (log)",
    "tom": "turn of the month (last 2 / first 3 trading days)",
}
GROUPS = {
    "momentum": ["ret_21", "ret_63", "ret_252", "mom_12_1", "dist_ma50", "dist_ma200"],
    "reversal": ["ret_1", "ret_5", "z_20", "rsi_14", "range_pos_20", "streak", "gap"],
    "volatility": ["vol_21", "vol_ratio", "skew_63", "drawdown_252", "volume_z"],
    "cross_section": ["xs_mom_63", "xs_mom_252", "xs_rev_5", "xs_vol"],
    "context": ["mkt_trend", "mkt_ret_21", "credit", "vix", "vix_ts", "tom"],
}
HORIZONS = (1, 5, 21)


def gk_var(df):
    """Garman-Klass daily variance from OHLC: ~5x more efficient than close-to-close."""
    o, h, l, c = (np.log(df[k].replace(0, np.nan)) for k in ("Open", "High", "Low", "Close"))
    hl, co = h - l, c - o
    return (0.5 * hl ** 2 - (2 * np.log(2) - 1) * co ** 2).clip(lower=0)


def _naive(df):
    x = df.copy()
    x.index = pd.DatetimeIndex(x.index).tz_localize(None).normalize() if getattr(x.index, "tz", None) else pd.DatetimeIndex(x.index).normalize()
    return x[~x.index.duplicated(keep="last")]


def per_market(df, iv_vix=None):
    """Features of one market (DataFrame indexed by date) + its vol scale + forward returns."""
    df = _naive(df)
    c, o = df["Close"], df["Open"]
    r = np.log(c).diff()
    vol = np.sqrt(gk_var(df).rolling(63, min_periods=40).mean() * 252).clip(lower=0.02)      # annualized, slow, robust
    vd = vol / np.sqrt(252)                                                                 # daily vol
    f = pd.DataFrame(index=df.index)
    for k in (1, 5, 21, 63, 252):
        f[f"ret_{k}"] = np.log(c / c.shift(k)) / (vd * np.sqrt(k))
    f["mom_12_1"] = np.log(c.shift(21) / c.shift(252)) / (vd * np.sqrt(231))
    for n in (50, 200):
        f[f"dist_ma{n}"] = np.log(c / c.rolling(n).mean()) / (vd * np.sqrt(n / 2))
    m, s = c.rolling(20).mean(), c.rolling(20).std()
    f["z_20"] = (c - m) / s.replace(0, np.nan)
    up, dn = r.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean(), (-r.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    f["rsi_14"] = (100 - 100 / (1 + up / dn.replace(0, np.nan))) / 100 - 0.5
    hh, ll = df["High"].rolling(20).max(), df["Low"].rolling(20).min()
    f["range_pos_20"] = (c - ll) / (hh - ll).replace(0, np.nan) - 0.5
    sign = np.sign(r).fillna(0)
    grp = (sign != sign.shift()).cumsum()
    f["streak"] = (sign.groupby(grp).cumcount() + 1) * sign
    f["gap"] = np.log(o / c.shift()) / vd
    f["drawdown_252"] = np.log(c / c.rolling(252, min_periods=60).max()) / (vd * np.sqrt(63))
    rv21 = np.sqrt(gk_var(df).rolling(21).mean() * 252)
    f["vol_21"] = np.log(rv21.clip(lower=0.01))
    f["vol_ratio"] = np.log(rv21 / vol)
    f["skew_63"] = r.rolling(63).skew()
    v = df["Volume"].replace(0, np.nan) if "Volume" in df else None
    f["volume_z"] = ((v - v.rolling(21).mean()) / v.rolling(21).std()) if v is not None else np.nan
    day = pd.Series(df.index, index=df.index)
    month = day.dt.to_period("M")
    pos = day.groupby(month).cumcount()
    left = day.groupby(month).transform("count") - pos - 1
    f["tom"] = ((pos <= 2) | (left <= 1)).astype(float)
    fwd = {h: np.log(c.shift(-h) / c) for h in HORIZONS}
    return f, vd, fwd


def panel(daily: dict, iv: dict | None = None, syms=None) -> dict:
    """All markets stacked: {'X': features (MultiIndex date, sym), 'y{h}': vol-scaled forward returns, 'r{h}': raw forward
    returns, 'vd': daily vol}. Market context comes from SPY / HYG / IEF and the VIX."""
    syms = [s for s in (syms or C.DAILY_UNIVERSE) if s in daily and len(daily[s]) > 300]
    parts, ys, rs, vds = [], {h: [] for h in HORIZONS}, {h: [] for h in HORIZONS}, []
    for s in syms:
        f, vd, fwd = per_market(daily[s])
        f["sym"] = s
        parts.append(f)
        vds.append(vd.rename(s))
        for h in HORIZONS:
            rs[h].append(fwd[h].rename(s))
            ys[h].append((fwd[h] / (vd * np.sqrt(h))).rename(s))
    X = pd.concat(parts)
    X.index.name = "date"
    X = X.set_index("sym", append=True).sort_index()
    # cross-sectional ranks (only dates with 6+ markets)
    for src, dst in (("ret_63", "xs_mom_63"), ("ret_252", "xs_mom_252"), ("ret_5", "xs_rev_5"), ("vol_21", "xs_vol")):
        g = X[src].groupby(level="date")
        X[dst] = g.rank(pct=True).where(g.transform("count") >= 6) - 0.5
    # context
    ctx = pd.DataFrame(index=X.index.get_level_values("date").unique().sort_values())
    if "SPY" in daily:
        spy = _naive(daily["SPY"])["Close"]
        ctx["mkt_trend"] = (spy > spy.rolling(200).mean()).astype(float) - 0.5
        vd_spy = np.sqrt(gk_var(_naive(daily["SPY"])).rolling(63, min_periods=40).mean())
        ctx["mkt_ret_21"] = np.log(spy / spy.shift(21)) / (vd_spy * np.sqrt(21))
    if "HYG" in daily and "IEF" in daily:
        ratio = np.log(_naive(daily["HYG"])["Close"] / _naive(daily["IEF"])["Close"])
        ctx["credit"] = (ratio - ratio.shift(63)) / ratio.diff().rolling(252, min_periods=60).std().replace(0, np.nan) / np.sqrt(63)
    if iv and "SPY" in iv:
        ctx["vix"] = np.log(iv["SPY"])
        if "VIX3M" in iv:
            ctx["vix_ts"] = np.log(iv["SPY"] / iv["VIX3M"])
    ctx = ctx.ffill(limit=3)
    for col in ctx.columns:
        X[col] = ctx[col].reindex(X.index.get_level_values("date")).values
    for col in FEATURES:
        if col not in X:
            X[col] = np.nan
    X = X[list(FEATURES)].replace([np.inf, -np.inf], np.nan).clip(-6, 6)
    stack = lambda L: pd.concat(L, axis=1).stack().rename_axis(["date", "sym"]).reindex(X.index)   # noqa: E731
    out = dict(X=X, vd=stack(vds))
    for h in HORIZONS:
        out[f"y{h}"] = stack(ys[h]).clip(-6, 6)
        out[f"r{h}"] = stack(rs[h])
    return out
