"""The Strategy Builder: Jason designs a strategy from the same lego blocks the AI researchers use (firm/blocks.py),
backtests it on 10+ years of daily bars with realistic costs, and gets the lab's real verdict: the same gate every AI
idea faces, including the multiple-testing bar (each of his tests counts as one more idea tested, so trying 50
variants until one passes doesn't fool the bar). A strategy that passes can go to the Incubator, paper-trade forward
like any other idea, and get hired as a PM if it proves itself."""
import asyncio
import time

from . import config as C
from .backtest import evaluate_daily, verdict_daily, fmt_daily, required_t, random_baseline, beats_random
from .blocks import BLOCKS, MAX_RULES
from .strategies import clean, describe, FAMILIES

DAILY_MAX = 40


class Builder:
    def __init__(self, floor, st: dict):
        self.f = floor
        self.running = False
        self.last: dict | None = st.get("last")       # the most recent result (also kept across restarts)
        self.tests: list = st.get("tests", [])[-30:]   # [{t, name, passed, pf, t_stat}]
        self.day, self.n = None, 0

    def to_state(self):
        return dict(last=self.last, tests=self.tests[-30:])

    async def test(self, msg):
        f = self.f
        if self.running:
            return
        today = time.strftime("%Y-%m-%d")
        if self.day != today:
            self.day, self.n = today, 0
        if self.n >= DAILY_MAX:
            await f.say("ava", "research", f"That's {DAILY_MAX} backtests today, Jason. The bar gets harder with every test: sleep on it.", pause=1)
            return
        params = clean("custom", dict(rules=msg.get("rules"), direction=msg.get("direction"), stop_atr=msg.get("stop_atr"),
                                      trail_atr=msg.get("trail_atr"), max_bars=msg.get("max_bars")))
        if not msg.get("rules"):
            return
        name = " ".join(str(msg.get("name", "")).split())[:40] or "Jason's strategy"
        self.running = True
        await f.push()
        try:
            if not f.lab.daily:
                await f.lab._get_history()
                if not f.lab.running:
                    f.lab.status = "idle"
            hist = f.lab.daily
            want = msg.get("markets")
            markets = [s for s in (want if isinstance(want, list) and want else C.DAILY_UNIVERSE) if s in hist and s in C.INST] or list(C.DAILY_UNIVERSE)
            self.n += 1
            f.lab.base_tests += 1                       # Jason's idea counts toward the multiple-testing bar like any other
            n_tests = f.lab.n_tests()
            await f.say("ava", "research", f"Running Jason's \"{name}\": {describe('custom', params)}. {len(markets)} markets, 10+ years, real costs.", pause=1)
            res = await asyncio.to_thread(evaluate_daily, hist, "custom", params, markets)
            others = await asyncio.to_thread(f.lab.team_monthly)
            ok, why = verdict_daily(res, n_tests, others)
            base = await asyncio.to_thread(random_baseline, hist, "custom", params, markets, res) if res["all"]["n"] else dict(pf=0.0, avg=0.0)
            okr, tr = beats_random(res, base) if res["all"]["n"] else (False, 0.0)
            if ok:
                ok, why = (True, f"{why}, beats random entries (t={tr:.1f})") if okr else                     (False, f"entries don't beat random entries with the same exits (random PF {base['pf']:.2f}, excess t={tr:.1f})")
            a = res["all"]
            curve, eq = [], 1.0
            for t, r in res["monthly"].items():
                eq *= 1 + r
                curve.append([t.strftime("%Y-%m"), round(eq, 4)])
            per = {}
            tr = res.get("trades")
            if tr is not None and len(tr):
                for s, g in tr.groupby("sym"):
                    w, l = g.ret[g.ret > 0].sum(), -g.ret[g.ret < 0].sum()
                    per[s] = dict(n=int(len(g)), pf=round(float(w / l), 2) if l > 0 else None, ret=round(float(g.ret.sum()), 4))
            self.last = dict(t=time.time(), name=name, params=params, desc=describe("custom", params), markets=res.get("markets", markets),
                             passed=ok, why=why, summary=fmt_daily(res) if a["n"] else "no trades", n=a["n"], pf=a["pf"], win=a["win"],
                             t_stat=res["t"], need_t=required_t(n_tests), n_tests=n_tests, cagr=res.get("cagr", 0.0), maxdd=res["maxdd"],
                             folds=[dict(n=x["n"], pf=x["pf"]) for x in res["folds"]], recent=dict(n=res["recent"]["n"], pf=res["recent"]["pf"]),
                             curve=curve[-400:], per=per, submitted=False, rand_pf=base["pf"], rand_t=tr)
            self.tests = (self.tests + [dict(t=time.time(), name=name, passed=ok, pf=a["pf"], t_stat=res["t"])])[-30:]
            if ok:
                await f.say("ava", "research", f"Jason's \"{name}\" PASSED the lab: {why}. That's a real result. Send it to the incubator?", pause=1, ok=True)
            else:
                await f.say("ava", "research", f"Jason's \"{name}\" didn't pass: {why}.", pause=1, ok=False)
        except Exception as e:      # never let a builder test crash the floor
            await f.say("dot", "chatter", f"Strategy Builder failed: {e!r}"[:140])
        finally:
            self.running = False
            f.save()
            await f.push()

    async def submit(self):
        f, L = self.f, self.last
        if not L or not L["passed"] or L.get("submitted"):
            return
        L["submitted"] = True
        e = dict(name=L["name"], family="custom", params=L["params"], markets=L["markets"], tf="1d", by="jason",
                 oos=dict(pf=L["pf"]), result=L["summary"])
        await f.incubator.admit(e, by="jason", why="designed by Jason in the Strategy Builder")
        f.save()

    def snapshot(self):
        return dict(running=self.running, last=self.last, tests=self.tests[-8:], n_tests=self.f.lab.n_tests(),
                    blocks={k: dict(desc=d, params={p: list(r) for p, r in ps.items()}) for k, (d, ps) in BLOCKS.items()},
                    max_rules=MAX_RULES, risk={k: list(v) for k, v in FAMILIES["custom"].items() if k != "direction"},
                    universe=[s for s in C.DAILY_UNIVERSE if s in C.INST])
