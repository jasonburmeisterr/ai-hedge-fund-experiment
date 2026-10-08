"""The Quant Toolbox: research instruments for the whole firm, and the evidence the CIO uses to set each pod's risk.

Tools (on the same 10+ years of data the lab uses; recomputed every few hours, when a strategy changes, or when Jason
moves a risk slider):
  1. Monte Carlo risk lab (montecarlo.py): thousands of reshuffled trade histories per pod -> chance of hitting the
     pod's drawdown stop, return cone, and the Kelly point where growth peaks
  2. Robustness ("plateau") test: nudge every setting of the strategy up and down. A real edge still works next door;
     a curve-fit one only works at the exact numbers
  3. Crisis stress test: what the pod's strategy did in real crashes (COVID, the 2022 bear market, the 2025 tariff
     shock, ...), at the risk the CIO wants to give it
  4. Factor X-ray: how much of the pod's returns is plain SPY / bonds / gold / bitcoin exposure, and what's left (alpha)
  5. Overfitting check (overfit.py): the deflated Sharpe ratio of each pod (is it real after N ideas tested?) and the
     probability of backtest overfitting of the lab's whole selection process (CSCV over every idea it has tested)
  6. Alternate histories (overfit.py): each pod's strategy re-run on 16 made-up decades built from reshuffled real data

The CIO's risk dial per pod (risk per trade, as a share of the pod's capital):
  Monte Carlo pick (risk appetite x Kelly, never past the ruin limit)
  x robustness (fragile edges get less) x overfitting (low deflated Sharpe, a lab that mostly picks luck, or an edge
  that fails in most alternate histories all cut risk) x crisis cap (the worst real crash must fit inside the pod's drawdown stop),
  within [MIN_POD_RISK, MAX_POD_RISK]. On the floor, a pod halfway to its drawdown stop trades half that (Floor.pod_risk).
The backtest edge is haircut by HAIRCUT, and live paper trades take over the evidence as they pile up.
Pods without a backtest (Opal's options desk) keep the starting risk (RISK_PER_TRADE)."""
import asyncio
import copy
import hashlib
import json
import time

import numpy as np
import pandas as pd

from . import config as C
from . import montecarlo as MC
from .backtest import evaluate_daily
from .blocks import BLOCKS, INT_KEYS
from .overlap import book, market_returns
from .overfit import alternate_worlds, deflated_sharpe, pbo_cscv, sharpe, world_test
from .strategies import FAMILIES, INT_PARAMS, clean

EVERY_H = 6
HAIRCUT = 0.5          # live results tend to come in around half the backtest edge (selection bias + decay)
LIVE_PRIOR = 30        # live trades get weight n / (n + 30) in the Monte Carlo pool
MIN_BT_TRADES = 20
NUDGES = (0.7, 0.85, 1.15, 1.3)
FACTORS = ["SPY", "TLT", "GLD", "BTC"]
CRISES = [
    ("Aug 2015 China devaluation", "2015-08-17", "2015-08-28"),
    ("Feb 2018 volatility blow-up", "2018-01-26", "2018-02-16"),
    ("Q4 2018 selloff", "2018-10-03", "2018-12-31"),
    ("COVID crash", "2020-02-19", "2020-03-31"),
    ("2022 rate-hike bear market", "2022-01-03", "2022-10-14"),
    ("Crypto: LUNA collapse", "2022-05-05", "2022-06-24"),
    ("Crypto: FTX collapse", "2022-11-06", "2022-11-25"),
    ("Mar 2023 bank failures", "2023-03-08", "2023-03-24"),
    ("Apr 2025 tariff shock", "2025-04-02", "2025-04-15"),
]


def _sig(*parts):
    return hashlib.md5(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def _nudged(v, m, lo, hi, is_int):
    v2 = max(lo, min(hi, v * m))
    return int(round(v2)) if is_int else round(v2, 4)


def neighbors(family, p):
    """Every numeric setting (strategy params and lego-block params) nudged by each factor in NUDGES, one at a time."""
    out = []
    for k, rule in FAMILIES[family].items():
        if isinstance(rule[0], list) or not p.get(k):
            continue
        for m in NUDGES:
            v = _nudged(p[k], m, rule[0], rule[1], k in INT_PARAMS)
            if v != p[k]:
                q = copy.deepcopy(p)
                q[k] = v
                out.append((f"{k} {p[k]:g}->{v:g}", q))
    for key in ("rules", "extra"):
        for i, r in enumerate(p.get(key) or []):
            for k, (lo, hi, _) in BLOCKS[r["block"]][1].items():
                v0 = r["params"].get(k)
                if not v0:
                    continue
                for m in NUDGES:
                    v = _nudged(v0, m, lo, hi, k in INT_KEYS)
                    if v != v0:
                        q = copy.deepcopy(p)
                        q[key][i]["params"][k] = v
                        out.append((f"{r['block']}.{k} {v0:g}->{v:g}", q))
    return out


def robustness(hist, family, p, markets, base_pf):
    nb = neighbors(family, p)
    if not nb:
        return dict(score=1.0, n=0, ok=0, pf_med=base_pf, base_pf=base_pf, worst=None)
    pfs, ok, worst = [], 0, None
    for label, q in nb:
        a = evaluate_daily(hist, family, clean(family, q), markets)["all"]
        pfs.append(a["pf"])
        ok += a["n"] >= MIN_BT_TRADES and a["pf"] >= 1.1
        if worst is None or a["pf"] < worst[1]:
            worst = (label, round(a["pf"], 2))
    return dict(score=ok / len(nb), n=len(nb), ok=ok, pf_med=float(np.median(pfs)), base_pf=base_pf, worst=worst)


def xray(daily, R, tr, tf):
    """OLS of the pod's weekly book return on weekly SPY / TLT / GLD / BTC returns."""
    _, pnl = book(daily, R, tr, tf)
    facs = [s for s in FACTORS if s in daily]
    if pnl is None or not facs:
        return None
    y = pnl.resample("W").sum().rename("pod")
    X = pd.concat({s: daily[s]["Close"].pct_change().resample("W").sum() for s in facs}, axis=1)
    if getattr(X.index, "tz", None) is not None:
        X.index = X.index.tz_localize(None)
    if getattr(y.index, "tz", None) is not None:
        y.index = y.index.tz_localize(None)
    d = pd.concat([y, X], axis=1).dropna()
    d = d[d.index >= d.index[-1] - pd.DateOffset(years=10)] if len(d) else d
    if len(d) < 100 or d["pod"].std() == 0:
        return None
    A = np.column_stack([np.ones(len(d))] + [d[s].values for s in facs])
    coef, *_ = np.linalg.lstsq(A, d["pod"].values, rcond=None)
    resid = d["pod"].values - A @ coef
    s2 = resid @ resid / max(1, len(d) - A.shape[1])
    se = np.sqrt(np.diag(s2 * np.linalg.pinv(A.T @ A)))
    r2 = 1 - (resid @ resid) / (((d["pod"] - d["pod"].mean()) ** 2).sum())
    return dict(betas={s: round(float(b), 2) for s, b in zip(facs, coef[1:])}, r2=round(float(r2), 2),
                alpha_ann=round(float(coef[0] * 52), 4), alpha_t=round(float(coef[0] / se[0]), 2) if se[0] > 0 else 0.0, weeks=len(d))


class Toolbox:
    def __init__(self, floor, st: dict):
        self.f = floor
        self.pods: dict = st.get("pods", {})       # aid -> tool results for the UI / reflections
        self.dials: dict = st.get("dials", {})     # aid -> the CIO's risk dial and its evidence
        self.key = st.get("key", "")
        self.last = st.get("last", 0.0)
        self.running = False
        self.firm: dict = st.get("firm", {})       # the lab's selection process: PBO, trials, Sharpe dispersion
        self._heavy: dict = {}                     # aid -> backtest arrays + slow tool results, keyed by strategy signature
        self._trials = None                        # cached trial matrix (every idea the lab tested)
        self._worlds = None                        # (day, alternate histories)

    def to_state(self):
        return dict(pods=self.pods, dials=self.dials, key=self.key, last=self.last, firm=self.firm)

    def eligible(self):
        f = self.f
        return [a for a in f.roster if a["family"] in FAMILIES and a.get("tf") in ("1d", "1h") and (a["tf"] == "1d" or f.hdesk.bars)]

    def inputs(self):
        f = self.f
        pods = [copy.deepcopy(a) for a in self.eligible()]          # the worker thread must not see roster edits mid-run
        since = {a["id"]: a.get("since", 0) for a in pods}
        live = [dict(pod=t["pod"], r=t["r"], sf=t["sf"], sym=t["sym"]) for t in f.broker.trades
                if t.get("r") is not None and t.get("sf") and not t.get("trim") and t.get("opened", 0) >= since.get(t.get("pod"), 0)]
        sets = dict(dd=C.POD_DD_LIMIT, app=C.RISK_APPETITE, hi=C.MAX_POD_RISK, lo=C.MIN_POD_RISK,
                    pos=C.MAX_POS_NOTIONAL, fut=C.MAX_FUT_LEVERAGE, sym=C.MAX_SYM_NOTIONAL)
        alloc = {a["id"]: round(max(f.alloc.get(a["id"], 0.0), C.MIN_ALLOC), 2) for a in pods}
        key = _sig([(a["id"], a["family"], a["params"], a.get("markets"), a.get("tf")) for a in pods], sets, alloc,
                   {a["id"]: sum(1 for t in live if t["pod"] == a["id"]) for a in pods})
        return pods, live, sets, alloc, key

    async def step(self):
        f = self.f
        if self.running or not f.lab.recertified or not f.lab.daily:
            return
        pods, live, sets, alloc, key = self.inputs()
        if not pods or (key == self.key and time.time() - self.last < EVERY_H * 3600):
            return
        self.running = True
        asyncio.create_task(self._run(pods, live, sets, alloc, key))     # in the background: the floor keeps trading meanwhile

    async def _run(self, pods, live, sets, alloc, key):
        f = self.f
        try:
            old = {i: d["risk"] for i, d in self.dials.items()}
            first = not self.dials
            out = await asyncio.to_thread(self.compute, pods, live, sets, alloc)
            self.pods, self.dials = out
            self.key, self.last = key, time.time()
            moved = [i for i, d in self.dials.items() if i not in old or abs(d["risk"] - old[i]) > 0.2 * max(old[i], 1e-9)]
            if moved:
                rows = sorted(self.dials.items(), key=lambda kv: -kv[1]["risk"])
                await f.say("boss", "system", ("Risk dials from the Monte Carlo lab" if first else "Risk dials updated") + ": "
                            + ", ".join(f"{f.names.get(i, i)} {d['risk']:.1%}/trade" for i, d in rows)
                            + ". Proven, robust edges get more; fragile or crisis-prone ones get less.", pause=2)
        except Exception as e:     # never let research tooling crash the floor; try again in 30 minutes, not every loop
            self.key, self.last = key, time.time() - EVERY_H * 3600 + 1800
            await f.say("dot", "chatter", f"Quant toolbox failed: {e!r}"[:140])
        finally:
            self.running = False

    # ── the heavy lifting (runs in a worker thread) ──
    def compute(self, pods, live, sets, alloc):
        f = self.f
        daily = f.lab.daily
        R_mkt = market_returns(daily)
        tm = self.trial_matrix(daily, pods)
        self.firm = {k: v for k, v in tm.items() if k != "sig"}
        day = time.strftime("%Y-%m-%d")
        if not self._worlds or self._worlds[0] != day:
            self._worlds = (day, alternate_worlds(daily))
        worlds = self._worlds[1]
        res_pods, dials = {}, {}
        for a in pods:
            aid, fam, tf = a["id"], a["family"], a.get("tf", "1d")
            hist, markets = f.lab.history_for(tf), a.get("markets") or C.DAILY_UNIVERSE
            sig = _sig(fam, a["params"], markets, tf)
            H = self._heavy.get(aid)
            if not H or H["sig"] != sig:
                H = self._heavy[aid] = self.heavy(sig, hist, daily, R_mkt, fam, a["params"], markets, tf)
            if not H:
                continue
            if tf == "1d" and worlds and H.get("synth_day") != day:
                H["synth"], H["synth_day"] = world_test(worlds, fam, a["params"], markets), day
            dsr, sr, sr0 = deflated_sharpe(H["monthly"], tm.get("n_trials", 1), tm.get("var_sr", 0.0))
            H["dsr"] = None if dsr is None else dict(dsr=round(dsr, 3), sr_ann=round(sr * 12 ** 0.5, 2), sr0_ann=round(sr0 * 12 ** 0.5, 2),
                                                     n_trials=tm.get("n_trials", 1))
            d = self.dial(aid, H, [t for t in live if t["pod"] == aid], sets, alloc[aid], tm)
            dials[aid] = d
            res_pods[aid] = dict(name=a["name"], n=H["n"], years=round(H["years"], 1), pf=round(H["pf"], 2), robust=H["robust"],
                                 factors=H["factors"], stress=d.pop("stress"), dsr=H.get("dsr"), synth=H.get("synth"), curve=H.get("curve"))
        return res_pods, dials

    def heavy(self, sig, hist, daily, R_mkt, fam, params, markets, tf):
        res = evaluate_daily(hist, fam, params, markets)
        tr = res.get("trades")
        if tr is None or len(tr) < MIN_BT_TRADES or "sf" not in tr:
            return None
        tr = tr[tr.sf > 0].sort_values("exit")
        ex = pd.to_datetime(tr.exit)
        if getattr(ex.dt, "tz", None) is not None:
            ex = ex.dt.tz_convert("America/New_York").dt.tz_localize(None)
        crisis = [(name, np.where((ex >= pd.Timestamp(a)) & (ex <= pd.Timestamp(b)))[0]) for name, a, b in CRISES]
        mo = res["monthly"]
        curve = [[int(pd.Timestamp(t).timestamp()), round(float(v), 4)] for t, v in (1 + mo).cumprod().items()]
        return dict(sig=sig, R=((tr.move - tr.cost) / tr.sf).values, sf=tr.sf.values, monthly=mo.to_numpy(float), curve=curve,
                    fut=tr.sym.map(lambda s: C.INST[s]["cls"] == "futures").values,
                    n=len(tr), years=res["years"], pf=res["all"]["pf"], crisis=[(n, ix) for n, ix in crisis if len(ix)],
                    robust=robustness(hist, fam, params, markets, res["all"]["pf"]),
                    factors=xray(daily, R_mkt, tr, tf))

    def trial_matrix(self, daily, pods):
        """Monthly returns of every idea the lab has tested (daily bars) plus the current pods: the selection set."""
        f = self.f
        log = [e for e in f.lab.log if e.get("tf", "1d") == "1d" and e.get("family") and e.get("params")][-60:]
        sig = _sig([(e["name"], round(e["t"])) for e in log], [(a["id"], a["params"]) for a in pods])
        if self._trials and self._trials["sig"] == sig:
            return dict(self._trials, n_trials=self._n_trials(self._trials))
        cols = {}
        for i, e in enumerate(log):
            m = evaluate_daily(daily, e["family"], e["params"], [s for s in e["markets"] if s in daily])["monthly"]
            if len(m) >= 24:
                cols[f"t{i}"] = m
        for a in pods:
            if a.get("tf", "1d") == "1d":
                m = evaluate_daily(daily, a["family"], a["params"], a.get("markets") or C.DAILY_UNIVERSE)["monthly"]
                if len(m) >= 24:
                    cols[a["id"]] = m
        out = dict(sig=sig, n_cols=len(cols), pbo=None, splits=0, logit=None, var_sr=0.0)
        if len(cols) >= 4:
            M = pd.concat(cols, axis=1)
            M = M[M.index >= M.index[-1] - pd.DateOffset(years=10)].fillna(0.0)
            out["pbo"], out["splits"], out["logit"] = pbo_cscv(M.values)
            srs = [sharpe(M[c].values) for c in M.columns]
            out["var_sr"] = float(np.var(srs, ddof=1)) if len(srs) > 1 else 0.0
            out["months"] = len(M)
            cm = np.nan_to_num(M.corr().values.clip(-1, 1))
            out["n_eff"] = round(float(max(1.0, min(len(cols), len(cols) ** 2 / max(cm.sum(), 1e-9)))), 1)
        self._trials = out
        return dict(out, n_trials=self._n_trials(out))

    def _n_trials(self, tm):
        """Ideas tested, scaled down to independent bets: 46 near-copies of one idea are one lottery ticket, not 46."""
        n = max(self.f.lab.n_tests(), tm["n_cols"])
        return max(2, round(n * tm.get("n_eff", tm["n_cols"]) / max(tm["n_cols"], 1)))

    def dial(self, aid, H, live, sets, alloc, tm=None):
        R, sf, fut = H["R"], H["sf"], H["fut"]
        Radj = R - HAIRCUT * max(float(R.mean()), 0.0)
        pool_R, pool_sf, pool_fut = Radj, sf, fut
        if live:
            w = len(live) / (len(live) + LIVE_PRIOR)
            k = max(1, round(w / (1 - w) * len(Radj) / len(live)))
            lr = np.tile([t["r"] for t in live], k)
            at = np.linspace(0, len(Radj), len(lr), endpoint=False).astype(int)     # spread the copies through history (not one clump)
            pool_R = np.insert(Radj, at, lr)
            pool_sf = np.insert(sf, at, np.tile([t["sf"] for t in live], k))
            pool_fut = np.insert(fut, at, np.tile([C.INST[t["sym"]]["cls"] == "futures" for t in live], k))
        cap_of = lambda fu: np.where(fu, min(sets["fut"], sets["sym"]), min(sets["pos"], sets["sym"])) / alloc   # position cap, pod-capital units
        n_year = max(10, H["n"] / max(H["years"], 0.5))
        curve = MC.risk_curve(pool_R, pool_sf, cap_of(pool_fut), n_year, sets["dd"])
        risk, kelly, why = MC.choose(curve, sets["app"], 0.2 * sets["app"], sets["lo"], sets["hi"])
        notes = [why]
        rb = H["robust"]["score"]
        mult = 1.0 if rb >= 0.75 else 0.8 if rb >= 0.5 else 0.5
        if mult < 1:
            risk *= mult
            notes.append(f"robustness {rb:.0%}: x{mult:g}")
        ds = (H.get("dsr") or {}).get("dsr")
        if ds is not None and ds < 0.9:
            k = 0.75 if ds < 0.5 else 0.9
            risk *= k
            notes.append(f"deflated Sharpe {ds:.0%} after ~{(tm or {}).get('n_trials', '?')} independent ideas tested: x{k:g}")
        sy = H.get("synth")
        if sy and sy["profitable"] < 0.5:
            risk *= 0.75
            notes.append(f"profitable in only {sy['profitable']:.0%} of alternate histories: x0.75")
        pbo = (tm or {}).get("pbo")
        if pbo is not None and pbo > 0.5:
            risk *= 0.85
            notes.append(f"the lab's picks look overfit (PBO {pbo:.0%}): x0.85")
        cap = cap_of(fut)

        def crash(r):
            return [(n, float(np.prod(1 + np.minimum(r, cap[ix] * sf[ix]) * R[ix]) - 1), len(ix)) for n, ix in H["crisis"]]
        st = crash(risk)
        worst = min(st, key=lambda x: x[1], default=None)
        if worst and worst[1] < -0.8 * sets["dd"]:
            risk *= 0.8 * sets["dd"] / abs(worst[1])
            notes.append(f"crisis cap: {worst[0]} would have cost {worst[1]:.0%}")
            st = crash(risk)
        risk = float(min(sets["hi"], max(sets["lo"], risk)))
        p = MC.point(pool_R, pool_sf, cap_of(pool_fut), n_year, sets["dd"], risk)
        return dict(risk=risk, kelly=kelly, why=notes, p_ruin=p["p_ruin"], p_loss=p["p_loss"], ret_med=p["ret_med"], ret_p5=p["ret_p5"],
                    ret_p95=p["ret_p95"], dd_med=p["dd_med"], dd_p5=p["dd_p5"], n_bt=H["n"], n_live=len(live), per_year=round(n_year),
                    edge=round(float(Radj.mean()), 3), r_sd=round(float(Radj.std()), 3), curve=[[c["risk"], round(c["p_ruin"], 3), round(c["ret_med"], 4), round(c["ret_p5"], 4)] for c in curve],
                    stress=[[n, round(v, 4), k] for n, v, k in st], t=time.time())

    def snapshot(self):
        return dict(pods=self.pods, dials=self.dials, running=self.running, last=self.last, haircut=HAIRCUT, every_h=EVERY_H, firm=self.firm)

    def brief_line(self):
        if not self.dials:
            return ""
        parts = []
        for aid, d in sorted(self.dials.items(), key=lambda kv: -kv[1]["risk"]):
            p = self.pods.get(aid, {})
            rb, fx = p.get("robust") or {}, p.get("factors") or {}
            worst = min(p.get("stress") or [], key=lambda x: x[1], default=None)
            top = max((fx.get("betas") or {}).items(), key=lambda kv: abs(kv[1]), default=None)
            ds, sy = p.get("dsr") or {}, p.get("synth") or {}
            parts.append(f"{p.get('name', aid)}: risk {d['risk']:.1%}/trade (Kelly {d['kelly']:.0%}, stop-out odds {d['p_ruin']:.0%}/yr), "
                         f"robust {rb.get('score', 0):.0%}" + (f", worst crisis {worst[0]} {worst[1]:+.0%}" if worst else "")
                         + (f", biggest factor {top[0]} beta {top[1]:+.2f} (R2 {fx['r2']:.2f}, alpha t {fx['alpha_t']:.1f})" if top else "")
                         + (f", deflated Sharpe {ds['dsr']:.0%}" if ds else "")
                         + (f", profitable in {sy['profitable']:.0%} of alternate histories" if sy else ""))
        pbo = self.firm.get("pbo")
        return ("Quant toolbox (Monte Carlo / robustness / crisis / factor X-ray / overfitting / alternate histories): " + "; ".join(parts)
                + (f". The lab's selection process: PBO {pbo:.0%} over {self.firm.get('n_cols')} ideas" if pbo is not None else ""))
