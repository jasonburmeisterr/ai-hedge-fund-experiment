"""The Model Lab: Kai (ML quant researcher) develops forecasting models the way a real quant team does.

Each session: a hypothesis with an economic reason -> a model spec (features from the vetted library, a forecast
horizon, a learner, a trading style) -> walk-forward validation with a purge gap, a permutation null, costs, alpha vs
buy-and-hold and a sealed 2-year holdout (firm/quant/validate.py) -> verdict. Every test counts toward the
multiple-testing bar. A model that passes AND survives the trading mechanics (stops, exits, costs) is hired as a PM
(or incubated if every desk is taken) and trades its live forecasts through the CIO, Rex and Eddie like anyone else.

The Vol Lab (firm/quant/vol.py) runs here too: HAR-RV forecasts and the iron-condor backtests for every underlying with
historical implied vol. Opal sells options only where a volatility model is validated."""
import asyncio
import random
import time

from .. import config as C
from ..llm import LLMError
from ..strategies import clean
from . import registry
from .features import FEATURES, GROUPS, HORIZONS, panel
from .ivdata import IV_SYMS, load_iv
from .learn import LEARNERS, available
from .validate import evaluate, required_t
from .vol import vrp_backtest

EVERY_MIN = 90
SPRINT_MIN = 25
VOL_EVERY_H = 12
KAI_SYSTEM = (
    "You are Kai, the machine-learning quant researcher at JB Capital, an AI-run multi-strategy fund that PAPER trades 22 liquid "
    "markets (US stock ETFs, sectors, bonds, gold, silver, oil, commodities, Nvidia, micro futures, BTC/ETH/SOL) on daily bars. "
    "You develop ONE forecasting model per session, like a real quant: start from an economic or behavioral reason a pattern "
    "should exist (risk premia, slow-moving capital, over-reaction, volatility clustering, flows), then choose few, relevant "
    "features. Avoid data mining: every model you test raises the significance bar for the next one. Validation is strict and "
    "realistic: walk-forward retraining with a purge gap, a permutation null, transaction costs, alpha versus buy-and-hold, and "
    "a sealed 2-year holdout you never see. Most models fail; that is normal. Learn from what failed. Reply only with the JSON.")


def kai_schema():
    return {"type": "object", "properties": {
        "notes": {"type": "string", "description": "1-2 sentences: what you learned from past models and why this one"},
        "model": {"type": "object", "properties": {
            "name": {"type": "string", "description": "short model name, max 5 words"},
            "hypothesis": {"type": "string", "description": "the economic reason this should forecast returns, 1-2 sentences"},
            "features": {"type": "array", "items": {"type": "string", "enum": list(FEATURES)}, "minItems": 2, "maxItems": 10},
            "horizon": {"type": "integer", "enum": list(HORIZONS)},
            "learner": {"type": "string", "enum": available()},
            "style": {"type": "string", "enum": ["cross_section", "timing"]},
            "direction": {"type": "string", "enum": ["both", "long", "short"]},
        }, "required": ["name", "hypothesis", "features", "horizon", "learner", "style", "direction"], "additionalProperties": False},
    }, "required": ["notes", "model"], "additionalProperties": False}


THEMES = [   # what Kai tries when the AI brain is off: classic, documented ideas
    dict(name="Cross-asset momentum", hypothesis="Trends persist across asset classes (slow-moving capital).", groups=["momentum", "cross_section"], horizon=21, style="cross_section"),
    dict(name="Short-term reversal", hypothesis="Liquidity providers get paid for absorbing one-week over-reactions.", groups=["reversal"], horizon=5, style="cross_section"),
    dict(name="Volatility-managed timing", hypothesis="Returns per unit of risk fall when volatility spikes; scale out of turbulence.", groups=["volatility", "context"], horizon=21, style="timing"),
    dict(name="Risk-on/risk-off timing", hypothesis="Credit spreads and the VIX term structure lead risky assets.", groups=["context", "momentum"], horizon=5, style="timing"),
    dict(name="Trend plus pullback", hypothesis="Buying dips inside long-term uptrends harvests both momentum and reversal.", groups=["momentum", "reversal"], horizon=5, style="timing"),
    dict(name="Non-linear regime model", hypothesis="Signals work differently by regime; trees can learn the interactions.", groups=["momentum", "volatility", "context"], horizon=5, style="timing", learner="gbm"),
]


class ModelLab:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.models: list = st.get("models", [])[-80:]
        self.n_tests = int(st.get("n_tests", 0))
        self.vol: dict = st.get("vol", {})
        self.vol_at = float(st.get("vol_at", 0))
        self.next_at = time.time() + 6 * 60
        self.running, self.status, self.current = False, "idle", None
        self.P, self.P_at, self.iv = None, 0.0, None
        self.live_day = None
        for m in self.models:                         # warm the registry for hired models
            if m.get("id"):
                registry.load(m["id"])

    def to_state(self):
        return dict(models=self.models[-80:], n_tests=self.n_tests, vol=self.vol, vol_at=self.vol_at)

    # ── data ──
    def _data(self):
        daily = self.f.lab.daily
        if not daily:
            from ..history import load_daily
            daily = load_daily()
        self.iv = load_iv()
        return panel(daily, self.iv), daily

    async def ensure_panel(self):
        if self.P is None or time.time() - self.P_at > 6 * 3600:
            self.P, _ = await asyncio.to_thread(self._data)
            self.P_at = time.time()
        return self.P

    # ── the loop ──
    async def step(self):
        f = self.f
        if self.running:
            return
        if time.time() - self.vol_at > VOL_EVERY_H * 3600:
            self.running = True
            asyncio.create_task(self._wrap(self.vol_lab()))
            return
        await self.refresh_live()
        if time.time() >= self.next_at and "kai" not in f.benched:
            sprint = f.cio.sprint_until > time.time()
            self.next_at = time.time() + (SPRINT_MIN if sprint else EVERY_MIN) * 60
            self.running = True
            asyncio.create_task(self._wrap(self.session()))

    async def _wrap(self, coro):
        try:
            await coro
        except Exception as e:      # research must never crash the floor
            await self.f.say("kai", "chatter", f"Model Lab error: {e!r}"[:160])
        finally:
            self.running, self.status, self.current = False, "idle", None
            self.f.save()
            await self.f.push()

    # ── a research session ──
    def _brief(self):
        f = self.f
        cat = "\n".join(f"- {k}: {v}" for k, v in FEATURES.items())
        groups = "\n".join(f"- {g}: {', '.join(v)}" for g, v in GROUPS.items())
        past = [m for m in self.models if m.get("by") != "jason"][-12:]
        log = "\n".join(f"- [{'PASS' if m['passed'] else 'FAIL'}] {m['name']} ({m['learner']}, {m['horizon']}d, {m['style']}; "
                        f"{', '.join(m['features'][:8])}): dev IC {m['ic']:+.3f} t={m['ic_t']:.1f}, Sharpe {m['sharpe']:.2f}, "
                        f"top features {', '.join(list(m.get('importance', {}))[:3])} -> {m['why'][:110]}" for m in past) or "- none yet"
        return (f"## Feature library (vol-scaled, look-ahead free)\n{cat}\n\n## Feature groups\n{groups}\n\n"
                f"## Learners available\n" + "\n".join(f"- {k}: {LEARNERS[k]}" for k in available()) +
                f"\n\n## Your past models (development-period results only; the holdout stays sealed)\n{log}\n\n"
                f"{f.cio.priorities_line()}\n"
                f"Models tested so far: {self.n_tests}. The IC significance bar is now t >= {required_t(self.n_tests + 1):.2f}.\n"
                "Cross-section = rank the 22 markets against each other each day (long the top, short the bottom). "
                "Timing = each market long/short by its own forecast. Propose ONE model that is genuinely different from what failed.")

    def _grid(self):
        th = dict(random.choice(THEMES))
        pool = [x for g in th["groups"] for x in GROUPS[g]]
        feats = random.sample(pool, k=min(len(pool), random.randint(3, 7)))
        learner = th.get("learner") if th.get("learner") in available() else random.choice(["ridge", "ridge", "logit"] + (["gbm"] if "gbm" in available() else []))
        return dict(name=th["name"], hypothesis=th["hypothesis"], features=feats, horizon=th["horizon"], learner=learner,
                    style=th["style"], direction="both"), "Brain offline: testing a classic idea from the literature."

    async def session(self, spec=None, by="kai"):
        f = self.f
        notes = ""
        if spec is None:
            self.status = "thinking"
            await f.say("kai", "model", "Model Lab session. Reading what failed last time before I build anything.", pause=2)
            if f.brain.enabled:
                try:
                    out = await asyncio.to_thread(f.brain.ask, KAI_SYSTEM, self._brief(), kai_schema(), 300)
                    spec, notes = out["model"], out.get("notes", "")
                except (LLMError, KeyError):
                    spec = None
            if spec is None:
                spec, notes = self._grid()
        spec = dict(spec)
        spec["features"] = [x for x in dict.fromkeys(spec.get("features", [])) if x in FEATURES][:10]
        spec["horizon"] = int(spec.get("horizon", 5)) if int(spec.get("horizon", 5)) in HORIZONS else 5
        spec["learner"] = spec.get("learner") if spec.get("learner") in available() else "ridge"
        spec["style"] = spec.get("style") if spec.get("style") in ("cross_section", "timing") else "timing"
        spec["direction"] = spec.get("direction") if spec.get("direction") in ("both", "long", "short") else "both"
        spec["name"] = " ".join(str(spec.get("name", "Untitled model")).split())[:40]
        if len(spec["features"]) < 2:
            return
        if notes:
            await f.say("kai", "model", notes[:220], pause=2)
        self.current = dict(name=spec["name"], learner=spec["learner"], horizon=spec["horizon"], style=spec["style"],
                            features=spec["features"], hypothesis=str(spec.get("hypothesis", ""))[:240], by=by)
        await f.say("kai", "model", f"Model: \"{spec['name']}\". {spec.get('hypothesis', '')}"[:230], pause=3)
        self.status = "training"
        await f.say("kai", "model", f"Training a {spec['learner']} on {len(spec['features'])} features, {spec['horizon']}-day horizon, "
                    "walk-forward with a purge gap, sealed 2-year holdout...", pause=1)
        P = await self.ensure_panel()
        self.n_tests += 1
        res, final, pred = await asyncio.to_thread(evaluate, P, spec, self.n_tests)
        mid = f"m{int(time.time()) % 10**8}"
        entry = dict(id=mid, t=time.time(), by=by, **{k: spec[k] for k in ("name", "features", "horizon", "learner", "style", "direction")},
                     hypothesis=str(spec.get("hypothesis", ""))[:240], **{k: res[k] for k in (
                         "ic", "ic_t", "need_t", "ic_hold", "ic_years", "pos_years", "perm_p", "sharpe", "cagr", "maxdd", "sharpe_hold", "cagr_hold",
                         "alpha", "alpha_t", "beta", "turnover", "cost_yr", "importance", "signs", "curve", "holdout_from", "years", "passed", "why")},
                     status="failed")
        if res["passed"]:                              # does the forecast survive real trading mechanics (stops, exits, costs)?
            registry.save(mid, dict(name=spec["name"], learner=spec["learner"], horizon=spec["horizon"], style=spec["style"],
                                    features=spec["features"]), pred, final)
            params = clean("model", dict(model=mid, q=0.2, direction=spec["direction"], max_bars=max(2, spec["horizon"])))
            from ..backtest import evaluate_daily, fmt_daily
            tres = await asyncio.to_thread(evaluate_daily, f.lab.daily, "model", params, C.DAILY_UNIVERSE)
            entry["trade_pf"], entry["trade_n"] = tres["all"]["pf"], tres["all"]["n"]
            if tres["all"]["n"] < 40 or tres["all"]["pf"] < 1.1:
                entry["passed"] = False
                entry["why"] = f"forecasts are real (IC t={res['ic_t']:.1f}) but don't survive stops, exits and costs (traded PF {tres['all']['pf']:.2f})"
            else:
                entry["status"] = "hired"
                entry["trade_summary"] = fmt_daily(tres)
        self.models.append(entry)
        self.models = self.models[-80:]
        self.status = "verdict"
        await f.say("kai", "model_verdict", f"{'PASSED' if entry['passed'] else 'FAILED'}: \"{entry['name']}\". {entry['why']}"[:300], pause=3,
                    ok=entry["passed"], title=entry["name"])
        if entry["passed"]:
            e = dict(name=entry["name"], family="model", params=params, markets=list(C.DAILY_UNIVERSE), tf="1d",
                     result=entry.get("trade_summary", ""), oos=dict(pf=entry["trade_pf"]), hypothesis=entry["hypothesis"], by=by)
            await f.lab.hire(e, mentor=by if by in ("kai", "jason") else None)
            entry["status"] = "hired" if any(a.get("params", {}).get("model") == mid for a in f.roster) else                 "incubating" if any(x.get("params", {}).get("model") == mid for x in f.incubator.items) else "filed"

    async def refresh_live(self):
        """When a new daily bar arrives: extend every live model's forecasts (hired PMs and incubating models)."""
        live = {a["params"]["model"] for a in self.f.roster if a["family"] == "model"} |                {x["params"]["model"] for x in self.f.incubator.active() if x.get("family") == "model"}
        if not live:
            return
        daily = self.f.desk.daily or self.f.lab.daily
        if not daily or "SPY" not in daily:
            return
        day = max(str(df.index[-1])[:10] for df in daily.values() if df is not None and len(df))
        if day == self.live_day:
            return
        self.live_day = day
        P = await asyncio.to_thread(lambda: panel(daily, self.iv or load_iv()))
        self.P, self.P_at = P, time.time()
        for mid in live:
            m = registry.load(mid)
            if m:
                await asyncio.to_thread(registry.extend, mid, P["X"][m["meta"]["features"]])

    # ── the Vol Lab ──
    async def vol_lab(self):
        f = self.f
        self.status = "vol models"
        await f.say("kai", "model", "Vol Lab: refitting HAR volatility forecasts and re-running the iron-condor backtests on 18 years of implied vol.", pause=1)
        daily = f.lab.daily
        if not daily:
            await f.lab._get_history()
            daily = f.lab.daily
        iv = await asyncio.to_thread(load_iv)
        self.iv = iv
        out = {}
        for s in IV_SYMS:
            if s in daily and s in iv:
                r = await asyncio.to_thread(vrp_backtest, daily[s], iv[s], "crypto" if C.INST[s]["cls"] == "crypto" else "equity")
                if r:
                    out[s] = r
        self.vol, self.vol_at = out, time.time()
        good = [s for s, r in out.items() if r["passed"]]
        prem = [s for s, r in out.items() if not r["passed"] and self.premium_ok(r)]
        await f.say("kai", "model_verdict", f"Vol Lab: timing model validated on {', '.join(good) or 'nothing'}; premium-only (sell without timing) on "
                    f"{', '.join(prem) or 'nothing'}; no edge on {', '.join(s for s in out if s not in good and s not in prem) or 'nothing'}. Opal trades only the validated ones.", pause=2)

    @staticmethod
    def premium_ok(r):
        a = r["always"]
        return a["dev"]["avg"] > 0 and a["dev"]["t"] >= 2.0 and a["hold"]["n"] >= 8 and a["hold"]["avg"] > 0

    def vol_rule(self, sym, iv_now=None):
        """How Opal may sell options on this underlying: tier 'model' (IV / forecast >= k), 'premium' (always, IV / forecast >= 1)
        or 'none'. Returns dict(tier, k, fc, ratio)."""
        r = self.vol.get(sym)
        if not r:
            return None
        fc = (r.get("now") or {}).get("fc")
        iv = iv_now or (r.get("now") or {}).get("iv")
        ratio = iv / fc if iv and fc else None
        if r["passed"]:
            return dict(tier="model", k=r["k"], fc=fc, ratio=ratio)
        if self.premium_ok(r):
            return dict(tier="premium", k=1.0, fc=fc, ratio=ratio)
        return dict(tier="none", k=None, fc=fc, ratio=ratio)

    async def jason_test(self, msg):
        if self.running:
            return
        spec = dict(name=msg.get("name") or "Jason's model", hypothesis=str(msg.get("hypothesis", ""))[:240], features=msg.get("features") or [],
                    horizon=msg.get("horizon", 5), learner=msg.get("learner", "ridge"), style=msg.get("style", "timing"), direction=msg.get("direction", "both"))
        self.running = True
        asyncio.create_task(self._wrap(self.session(spec, by="jason")))

    def snapshot(self, compact=False):
        if compact:      # every push: just enough for the floor screens
            return dict(running=self.running, status=self.status, current=self.current, n_tests=self.n_tests,
                        need_t=required_t(self.n_tests + 1), next_in=max(0, int(self.next_at - time.time())),
                        models=[{k: m.get(k) for k in ("id", "name", "learner", "horizon", "style", "ic", "ic_t", "sharpe", "passed", "status", "by", "t")}
                                for m in self.models[-8:]][::-1],
                        vol={s: dict(tier=(self.vol_rule(s) or {}).get("tier"), now=r.get("now"), k=r.get("k")) for s, r in self.vol.items()})
        vol = {}
        for s, r in self.vol.items():
            vol[s] = {k: r[k] for k in ("always", "naive", "model", "k", "passed", "quality", "now", "holdout_from", "curve", "iv_curve", "rv_curve") if k in r}
            vol[s]["tier"] = (self.vol_rule(s) or {}).get("tier")
        return dict(running=self.running, status=self.status, current=self.current, n_tests=self.n_tests,
                    need_t=required_t(self.n_tests + 1), next_in=max(0, int(self.next_at - time.time())),
                    models=[{k: v for k, v in m.items() if k != "curve"} for m in self.models[-30:]][::-1],
                    curves={m["id"]: m.get("curve", [])[-180:] for m in self.models[-30:]},
                    vol=vol, vol_at=self.vol_at, features=FEATURES, groups=GROUPS, learners={k: LEARNERS[k] for k in available()},
                    horizons=list(HORIZONS))
