"""The R&D lab. Ava designs strategies; the backtest machine judges them on 10+ years of DAILY data across the
whole universe, with realistic costs. The bar is strict and gets stricter the more ideas she tries:
  - enough trades, profit factor >= 1.2 after costs
  - profitable in at least 3 of 4 separate time periods
  - statistically significant (t-stat bar rises with the number of ideas tested: a multiple-testing haircut)
  - drawdown limit, still working in the most recent period, and not a copy of an existing PM
Sessions alternate: invent a new PM / retrain the weakest PM. On startup every PM is re-certified under the
current cost model; PMs that fail are taken off the desk until the lab fixes them."""
import asyncio
import json
import os
import random
import time

from . import config as C
from .backtest import evaluate, verdict, evaluate_daily, verdict_daily, fmt_daily, random_baseline, beats_random
from .history import load as load_intraday, load_daily
from .llm import LLMError
from .blocks import block_schema, catalog
from .strategies import FAMILIES, clean, describe

PLAYBOOK = open(os.path.join(os.path.dirname(__file__), "playbook.md"), encoding="utf-8").read()
HIRE_NAMES = ["Nova", "Kai", "Zed", "Lux", "Orion", "Pixel", "Juno", "Vega", "Echo", "Rio", "Sage", "Blaze", "Ivy", "Quinn"]

SYSTEM = (
    "You are Ava, head of research at JB Capital, a small AI-run quant fund. You design trading strategies that are "
    "tested on 10+ years of daily data with realistic costs and a strict, multiple-testing-adjusted bar. You are "
    "skeptical and scientific: learn from the research log, avoid curve-fitting, prefer simple ideas with an economic "
    "reason that work across many markets. You can only use the strategy families and parameters described, or INVENT a new "
    "strategy with family 'custom' by combining 1-3 lego blocks in `rules`. Build on what the team has learned. Reply only with the JSON."
)


def proposal_schema(syms):
    params = {}
    for name, fam in FAMILIES.items():
        if name == "model":                        # models come from the Model Lab (Kai), not from rule proposals
            continue
        for k, rule in fam.items():
            if isinstance(rule[0], list):
                params[k] = {"type": "boolean"} if isinstance(rule[0][0], bool) else {"type": "string", "enum": rule[0]}
            else:
                params[k] = {"type": "number"}
    return {
        "type": "object",
        "properties": {
            "notes": {"type": "string", "description": "2-3 sentences: what you learned from the log and why these ideas"},
            "proposals": {"type": "array", "items": {"type": "object", "properties": {
                "name": {"type": "string", "description": "short catchy idea name, max 4 words"},
                "family": {"type": "string", "enum": [k for k in FAMILIES if k != "model"]},
                "params": {"type": "object", "properties": params, "additionalProperties": False},
                "timeframe": {"type": "string", "enum": ["1d", "1h"],
                              "description": "bar size: 1d (default) or 1h (US ETFs/stocks + BTC/ETH/SOL only; costs bite much harder)"},
                "rules": {"type": "array", "maxItems": 3, "items": block_schema(),
                          "description": "ONLY for family 'custom': 1-3 lego blocks that must all be true to enter"},
                "markets": {"type": "array", "items": {"type": "string", "enum": syms}},
                "hypothesis": {"type": "string", "description": "max 25 words"},
                "failure_mode": {"type": "string", "description": "how this could fail, max 15 words"},
            }, "required": ["name", "family", "params", "markets", "hypothesis", "failure_mode"],
                "additionalProperties": False}},
        },
        "required": ["notes", "proposals"],
        "additionalProperties": False,
    }


def log_entry(name, fam, params, markets, prop, res, ok, reason, **extra):
    a = res["all"]
    tf = extra.pop("tf", "1d")
    return dict(t=time.time(), name=name, family=fam, params=params, markets=markets, tf=tf,
                hypothesis=prop.get("hypothesis", ""), failure_mode=prop.get("failure_mode", ""),
                result=fmt_daily(res), reason=reason, passed=ok,
                oos=dict(pf=a["pf"], ret=res.get("cagr", 0.0), n=a["n"], win=a["win"]), t_stat=res["t"],
                is_=dict(pf=a["pf"], ret=res.get("cagr", 0.0), n=a["n"]), **extra)


class Lab:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.log: list = st.get("research", [])
        # only the last 80 log entries are saved: remember how many ideas were tested before them (the significance bar
        # and the deflated Sharpe both depend on the true count)
        self.base_tests = max(0, int(st.get("lab_tests", 0)) - sum(1 for e in self.log if e.get("tf") in ("1d", "1h")))
        self.daily: dict = {}
        self.hist15: dict = {}
        self.hist_at = 0.0
        self.status = "idle"
        self.current = None
        self.next_at = time.time() + C.FIRST_RESEARCH_SEC
        self.running = False
        self.sessions = 0
        self.recertified = False
        self._monthly_cache: dict = {}

    def to_state(self):
        return self.log[-80:]

    def snapshot(self):
        return dict(status=self.status, current=self.current, next_in=max(0, int(self.next_at - time.time())),
                    log=self.log[-8:], on=self.floor.brain.enabled, tests=self.n_tests(),
                    t_bar=round(1.5 + 0.4 * __import__("math").log(1 + self.n_tests()), 2))

    def history_for(self, tf):
        """The bars a timeframe is researched and traded on."""
        return self.floor.hdesk.bars if tf == "1h" else self.daily

    def daily_syms(self):
        return [s for s in C.DAILY_UNIVERSE if s in self.daily] or list(C.DAILY_UNIVERSE)

    async def ensure_history(self):
        if not self.daily:
            await self._get_history()
            self.status = "idle"

    def n_tests(self):
        return self.base_tests + sum(1 for e in self.log if e.get("tf") in ("1d", "1h"))

    async def _get_history(self):
        if time.time() - self.hist_at > 6 * 3600 or not self.daily:
            self.status = "loading history"
            self.daily = await asyncio.to_thread(load_daily)
            self.hist_at = time.time()

    # ── startup: re-certify every PM under the current, realistic cost model ──
    async def recertify(self):
        f = self.floor
        await self._get_history()
        await f.say("rex", "system", "Re-certifying every PM under real-world costs and 10+ years of daily data. No exceptions.", pause=3)
        for a in list(f.roster):
            if a["family"] == "options":
                continue
            if a.get("tf") == "1h" and not f.hdesk.bars:
                continue                         # hourly history still loading: keep the 1h PM as it is
            if a.get("tf", "15m") in ("1d", "1h"):
                res = await asyncio.to_thread(evaluate_daily, self.history_for(a["tf"]), a["family"], a["params"], a.get("markets") or C.DAILY_UNIVERSE)
                ok, reason = verdict_daily(res, 1)
                a["bt"] = fmt_daily(res)
            else:
                if not self.hist15:
                    self.hist15 = await asyncio.to_thread(load_intraday)
                res = await asyncio.to_thread(evaluate, self.hist15, a["family"], a["params"], a.get("markets") or list(self.hist15))
                ok, reason = verdict(res)
                reason = f"15-minute version, real fees: {reason}"
                if not ok:   # re-platform: same rules, daily bars, the whole universe
                    dres = await asyncio.to_thread(evaluate_daily, self.daily, a["family"], a["params"], C.DAILY_UNIVERSE)
                    dok, dreason = verdict_daily(dres, 1, await asyncio.to_thread(self.team_monthly, a["id"]))
                    if dok:
                        a.update(tf="1d", markets=C.DAILY_UNIVERSE, bt=fmt_daily(dres), oos_pf=dres["all"]["pf"])
                        f.score.results[a["id"]] = []
                        ok, reason = True, f"15-minute version fails on real fees, so moved to DAILY bars on {len(C.DAILY_UNIVERSE)} markets: {dreason}"
                    else:
                        reason += f"; daily version also fails ({dreason})"
            if ok and a.get("tf", "15m") in ("1d", "1h"):     # alpha or beta? random entries with the same exits
                base = await asyncio.to_thread(random_baseline, self.history_for(a["tf"]), a["family"], a["params"], a.get("markets") or C.DAILY_UNIVERSE, res)
                okr, tr = beats_random(res, base)
                if okr:
                    f.cio.beta.pop(a["id"], None)
                    reason += f", entries beat random (t={tr:.1f})"
                else:
                    f.cio.beta[a["id"]] = (f"entries don't beat random entry days with the same exits (random PF {base['pf']:.2f} vs "
                                           f"{res['all']['pf']:.2f}, t={tr:.1f}): the returns look like market beta plus exits")
                    reason += f". BUT random entries with the same exits earn PF {base['pf']:.2f}: treated as beta (half size)"
            if ok:
                f.stopped.pop(a["id"], None)
                await f.say("rex", "risk", f"{a['name']}: CERTIFIED. {reason}", pause=2, ok=True, target=a["id"])
            else:
                f.stopped[a["id"]] = f"failed re-certification: {reason}"
                await f.say("rex", "risk", f"{a['name']}: FAILED re-certification ({reason}). Off the desk until the lab fixes it.",
                            pause=2.5, ok=False, target=a["id"])
        self.recertified = True
        f.reallocate(announce=False)
        f.save()
        await f.push()

    async def maybe_run(self):
        if self.running:
            return
        if not self.recertified:
            self.running = True
            asyncio.create_task(self._wrap(self.recertify()))
            return
        if not self.floor.brain.enabled or "ava" in self.floor.benched or time.time() < self.next_at:
            return
        sprint = self.floor.cio.sprint_until > time.time()          # Jason called a research sprint: a session every 20 minutes
        self.next_at = time.time() + (min(20, C.RESEARCH_EVERY_MIN) if sprint else C.RESEARCH_EVERY_MIN) * 60
        self.running = True
        asyncio.create_task(self._wrap(self._session()))

    async def _wrap(self, coro):
        try:
            await coro
        except Exception as e:  # never let research crash the floor
            await self.floor.say("ava", "chatter", f"Lab accident: {e!r}"[:140])
        finally:
            self.status, self.current, self.running = "idle", None, False
            self.floor.save()
            await self.floor.push()

    def team_monthly(self, exclude=None):
        """Backtest monthly returns of the current daily PMs, to reject copies of an existing strategy."""
        out = {}
        for a in self.floor.roster:
            if a["family"] == "options" or a.get("tf") not in ("1d", "1h") or a["id"] == exclude or a["id"] in self.floor.stopped:
                continue
            if a["tf"] == "1h" and not self.floor.hdesk.bars:
                continue
            key = json.dumps([a["family"], a["params"], a.get("markets"), a["tf"]], sort_keys=True)
            if key not in self._monthly_cache:
                self._monthly_cache[key] = evaluate_daily(self.history_for(a["tf"]), a["family"], a["params"], a.get("markets") or C.DAILY_UNIVERSE)["monthly"]
            out[a["name"]] = self._monthly_cache[key]
        return out

    def brief(self, syms):
        f = self.floor
        team = []
        for a in f.roster:
            if a["family"] == "options":
                team.append(f"- {a['name']} (options desk, live-graded only): {a['desc']}")
                continue
            st = f.score.stats(a["id"])
            live = "no graded calls yet" if not st["n"] else f"{st['n']} graded calls, hit {st['hit']:.0%}, edge {st['edge_bps']:+.1f}bps"
            status = f" [OFF DESK: {f.stopped[a['id']]}]" if a["id"] in f.stopped else ""
            team.append(f"- {a['name']} ({a.get('tf', '15m')}, {'founder' if a.get('founder') else 'hire'}){status}: "
                        f"{a['family']} {a['params']} on {a.get('markets') or 'all'} | live: {live} | backtest: {a.get('bt', 'n/a')}")
        log = [f"- [{'PASS' if e['passed'] else 'FAIL'}] {e['name']}: {e['family']} {e['params']} on {e['markets']} -> "
               f"{e.get('result', '')} ({e['reason']})" for e in reversed([e for e in self.log if e.get("tf") in ("1d", "1h")][-15:])]
        mk = []
        for s in syms:
            df = self.daily.get(s)
            if df is None or len(df) < 300:
                continue
            c = df["Close"]
            mk.append(f"- {s} ({C.INST[s]['cls']}, {C.INST[s]['name']}): since {df.index[0].year}, 1y {c.iloc[-1] / c.iloc[-252] - 1:+.0%}, "
                      f"costs {(C.INST[s].get('fee_pct', 0) + C.INST[s]['slip_pct']) * 100:.2f}%/side")
        fam = "\n".join(f"- {k}: " + ", ".join(f"{p}={'|'.join(map(str, r[0])) if isinstance(r[0], list) else f'{r[0]}..{r[1]}'}"
                                                for p, r in v.items()) for k, v in FAMILIES.items() if k != "model")
        n = self.n_tests()
        return (f"{PLAYBOOK}\n\n## Strategy families and allowed parameters\n{fam}\n"
                "(lengths are in BARS of the chosen timeframe; vol_min/vol_max = ATR percentile rank 0..1; stop/trail in ATRs; max_bars = holding bars)\n"
                f"Timeframes: '1d' daily bars on every market (default), or '1h' hourly bars ({len(self.floor.hdesk.bars)} markets: "
                f"{', '.join(sorted(self.floor.hdesk.bars)) or 'history still loading, do not propose 1h yet'}; regular hours for stocks, 24/7 crypto). "
                "Per-trade costs are the same, so 1h ideas need a bigger edge per trade. A stock day has ~7 hourly bars; crypto 24.\n"
                f"\n## Lego blocks for family 'custom' (put them in `rules`; ALL must be true to enter; shorts use the mirror)\n{catalog()}\n\n"
                f"{self.floor.minds.knowledge_brief(self.log)}\n{self.floor.overlap.brief_line()}\n"
                f"{self.floor.incubator.brief_line()}\n{self.floor.toolbox.brief_line()}\n"
                + ("(Every desk is taken: a new strategy that passes goes to the Incubator and must prove itself on live paper "
                   "data, so propose ideas that are genuinely DIFFERENT from the team AND from what is already incubating.)\n"
                   if sum(1 for a in f.roster if not a.get("founder")) >= C.MAX_HIRES else "") +
                "\n" + self.floor.cio.priorities_line() +
                "\n## Current team\n" + "\n".join(team) +
                f"\n\n## Research log ({n} daily ideas tested so far; the significance bar is now t >= {1.5 + 0.4 * __import__('math').log(1 + n):.2f})\n" +
                ("\n".join(log) or "- nothing yet: this is the first daily session") +
                "\n\n## Universe (daily history)\n" + "\n".join(mk) +
                f"\n\nPropose exactly {C.IDEAS_PER_SESSION} NEW daily strategies that are meaningfully different from everything in the "
                "log AND from the current team (the backtester rejects anything >0.7 correlated with an existing PM). Prefer "
                "strategies that trade MANY markets (8+) so they get enough trades; long-only is fine.")

    async def _session(self):
        f = self.floor
        await self._get_history()
        syms = [s for s in C.DAILY_UNIVERSE if s in self.daily]
        self.sessions += 1
        pitches = [self.floor.minds.next_pitch() for _ in range(C.IDEAS_PER_SESSION)]
        pitches = [p for p in pitches if p]
        if pitches:
            self.status = "thinking"
            await f.say("ava", "research", f"Lab session for the team's pitches: {', '.join(f.names.get(p['by'], p['by']) for p in pitches)}.",
                        pause=4, step="go")
            for p in pitches:
                await f.say(p["by"], "pitch", f'My idea, "{p["name"]}". {p["hypothesis"]}'[:230], pause=3)
                await self._test(p, syms, pitched_by=p["by"])
            return
        focus = next((a for a in f.roster if a["id"] == f.cio.lab_focus and a["family"] != "options"), None)
        if focus:                                     # the CIO (or Jason) sent this PM to the lab: it goes first
            f.cio.lab_focus = None
            return await self._tune(focus, syms)
        target = self.tune_target() if self.sessions % 2 == 0 else None
        if target:
            return await self._tune(target, syms)
        self.status = "thinking"
        await f.say("ava", "research", "Heading to the lab. Time to invent something new.", pause=4, step="go")
        try:
            out = await asyncio.to_thread(f.brain.ask, SYSTEM, self.brief(syms), proposal_schema(syms))
        except LLMError as e:
            await f.say("ava", "chatter", f"My research session failed: {e}")
            return
        if out.get("notes"):
            await f.say("ava", "research", out["notes"][:220], pause=5, step="notes")
        for prop in out.get("proposals", [])[:C.IDEAS_PER_SESSION]:
            await self._test(prop, syms)

    async def _test(self, prop, syms, pitched_by=None):
        f = self.floor
        fam = prop.get("family")
        if fam not in FAMILIES or fam == "model":
            return
        params = clean(fam, {**(prop.get("params") or {}), **({"rules": prop["rules"]} if prop.get("rules") else {})})
        tf = prop.get("timeframe") if prop.get("timeframe") == "1h" and f.hdesk.bars else "1d"
        hist = self.history_for(tf)
        if tf == "1h":
            syms = [m for m in syms if m in hist] or list(hist)
        markets = [m for m in prop.get("markets", []) if m in syms] or syms
        name = str(prop.get("name", "Untitled"))[:40]
        self.current = dict(name=name, family=fam, desc=describe(fam, params), markets=markets, hypothesis=prop.get("hypothesis", "")[:200])
        self.status = "idea"
        await f.say("ava", "idea", f'Idea: "{name}". {prop.get("hypothesis", "")}'[:230], pause=5, idea=self.current)
        self.status = "backtesting"
        await f.say("ava", "backtest", f"Backtesting {len(markets)} markets on {'10 years of HOURLY' if tf == '1h' else '10+ years of daily'} data, real costs...", pause=1)
        res = await asyncio.to_thread(evaluate_daily, hist, fam, params, markets)
        others = await asyncio.to_thread(self.team_monthly)
        n = self.n_tests() + 1
        ok, reason = verdict_daily(res, n, others)
        if ok:                                  # the null model: random entry days with the same exits must do clearly worse
            base = await asyncio.to_thread(random_baseline, hist, fam, params, markets, res)
            okr, tr = beats_random(res, base)
            ok, reason = (True, f"{reason}, beats random entries (t={tr:.1f})") if okr else                 (False, f"entries don't beat random entries with the same exits (random PF {base['pf']:.2f}, excess t={tr:.1f})")
        await asyncio.sleep(3)
        entry = log_entry(name, fam, params, markets, prop, res, ok, reason, by=pitched_by or "ava", tf=tf)
        self.log.append(entry)
        self.status = "verdict"
        await f.say("ava", "verdict", f"{'PASSED' if ok else 'FAILED'}: {name}. {reason}", pause=4, ok=ok, title=name)
        await f.minds.on_research(entry, "ava", pitched_by)
        if ok:
            pm = next((a for a in f.roster if a["id"] == pitched_by), None)
            if pm and pm["family"] != "options" and (pm["id"] in f.stopped or pm["id"] in f.benched
                                                     or entry["oos"]["pf"] > pm.get("oos_pf", 0) + 0.2):
                await self.retool(pm, entry)       # an idle PM who invented a winner gets to trade it themselves
            else:
                await self.hire(entry, mentor=pitched_by)

    # ── retraining: improve (or re-platform to daily) the weakest PM ──
    def tune_target(self):
        f = self.floor
        cands = [a for a in f.roster if a["family"] not in ("options", "model")]
        if not cands:
            return None
        def badness(a):
            st = f.score.stats(a["id"])
            return (a["id"] in f.stopped, a.get("tf", "15m") not in ("1d", "1h"), a["id"] in f.benched and a.get("founder"), -st["trust"], st["n"])
        return max(cands, key=badness)

    async def _tune(self, a, syms):
        f = self.floor
        markets = [m for m in (a.get("markets") or syms) if m in syms] or syms
        daily_now = a.get("tf", "15m") == "1d"
        self.status = "backtesting"
        base = await asyncio.to_thread(evaluate_daily, self.daily, a["family"], a["params"], markets) if daily_now else None
        why = f"current daily backtest: {fmt_daily(base)}" if base else "it currently trades 15-minute bars, which don't survive real costs"
        await f.say("ava", "research", f"Retraining session: {a['name']}'s pod ({why[:120]}).", pause=4, step="go", target=a["id"])
        self.status = "thinking"
        st = f.score.stats(a["id"])
        live = "no graded calls" if not st["n"] else f"{st['n']} graded calls, hit {st['hit']:.0%}, edge {st['edge_bps']:+.1f}bps"
        prompt = (self.brief(syms) +
                  f"\n\n## THIS SESSION: RETRAIN, DON'T INVENT\nPM {a['name']} trades {a['family']} {a['params']} on {markets} "
                  f"({'daily' if daily_now else '15-minute'} bars). Status: {f.stopped.get(a['id'], 'active')}. {why}. Live: {live}.\n"
                  f"Propose exactly 2 improved DAILY-bar variants of the SAME family ({a['family']}). You may change parameters, the "
                  f"volatility filter, direction and the market list (more markets = more evidence). Say what failure you are fixing.")
        try:
            out = await asyncio.to_thread(f.brain.ask, SYSTEM, prompt, proposal_schema(syms))
        except LLMError as e:
            await f.say("ava", "chatter", f"Retraining session failed: {e}")
            return
        best = None
        others = await asyncio.to_thread(self.team_monthly, a["id"])
        for prop in out.get("proposals", [])[:2]:
            params = clean(a["family"], {**(prop.get("params") or {}), **({"rules": prop["rules"]} if prop.get("rules") else {})})
            mk = [m for m in prop.get("markets", []) if m in syms] or markets
            name = f"{a['name']} v-next: {str(prop.get('name', 'variant'))[:28]}"
            self.current = dict(name=name, family=a["family"], desc=describe(a["family"], params), markets=mk, hypothesis=prop.get("hypothesis", "")[:200])
            self.status = "idea"
            await f.say("ava", "idea", f'{a["name"]}, try this: {prop.get("hypothesis", "")}'[:230], pause=4, idea=self.current)
            self.status = "backtesting"
            await f.say("ava", "backtest", f"Backtesting {a['name']}'s daily variant on {len(mk)} markets...", pause=1)
            res = await asyncio.to_thread(evaluate_daily, self.daily, a["family"], params, mk)
            await asyncio.sleep(3)
            ok, reason = verdict_daily(res, self.n_tests() + 1, others)
            better = ok and (base is None or res["all"]["pf"] > base["all"]["pf"] + 0.1 or a["id"] in f.stopped)
            if ok and not better:
                reason = f"passes, but not clearly better than the current version (PF {base['all']['pf']:.2f})"
            self.log.append(log_entry(name, a["family"], params, mk, prop, res, better, reason, tune=a["id"]))
            self.status = "verdict"
            await f.say("ava", "verdict", f"{'UPGRADE' if better else 'NO UPGRADE'}: {name}. {reason}", pause=3, ok=better, title=name)
            if better and (best is None or res["all"]["pf"] > best[2]["all"]["pf"]):
                best = (params, mk, res)
        if best:
            params, mk, res = best
            a.update(params=params, markets=mk, desc=describe(a["family"], params), bt=fmt_daily(res), oos_pf=res["all"]["pf"], tf="1d")
            f.score.results[a["id"]] = []          # new strategy, fresh track record
            a["since"] = time.time()
            f.stopped.pop(a["id"], None)
            f.pod_peak[a["id"]] = f.broker.pod_pnl(a["id"], f.prices())
            if a.get("founder"):
                f.benched.discard(a["id"])
            f.reallocate(announce=False)
            await f.say("boss", "upgrade", f"{a['name']} is upgraded to a daily strategy ({a['desc']}). Fresh risk budget, earn it back.",
                        pause=3, target=a["id"])
            await f.minds.on_career(a["id"], "upgrade", f"Retrained: now trading {a['desc'][:100]}.", xp=40, valence=1)
        else:
            await f.say("ava", "chatter", f"No upgrade for {a['name']} this time.")

    async def retool(self, a, e):
        f = self.floor
        a.update(family=e["family"], params=e["params"], markets=e["markets"], tf=e.get("tf", "1d"), desc=describe(e["family"], e["params"]),
                 bt=e["result"], oos_pf=e["oos"]["pf"], idea=e["name"])
        f.score.results[a["id"]] = []
        a["since"] = time.time()
        f.stopped.pop(a["id"], None)
        f.benched.discard(a["id"])
        f.pod_peak[a["id"]] = f.broker.pod_pnl(a["id"], f.prices())
        f.reallocate(announce=False)
        await f.say("boss", "upgrade", f"{a['name']} invented \"{e['name']}\" and it passed the bar. Back on the desk trading your own idea.",
                    pause=3, target=a["id"])
        await f.minds.on_career(a["id"], "comeback", f"Back on the desk with my own invention, {e['name']}.", xp=80, valence=1)

    async def hire(self, e, mentor=None, force=False):
        """A free desk (or one held by a stopped-out hire) goes to the new strategy. All desks busy: it goes to the incubator
        and has to prove itself on live paper data before it can replace anyone (force=True: an incubator graduate)."""
        f = self.floor
        hires = [a for a in f.roster if not a.get("founder")]
        if len(hires) >= C.MAX_HIRES:
            stopped = [a for a in hires if a["id"] in f.stopped]
            if not stopped and not force:
                await f.incubator.admit(e, by=mentor or e.get("by"))
                return
            if stopped:
                await self.fire(stopped[0], f"replaced by a stronger, certified strategy ({e['name']})")
        used = {a.get("slot") for a in f.roster if not a.get("founder")}
        slot = next(i for i in range(C.MAX_HIRES) if i not in used)
        taken = {a["name"] for a in f.roster}
        name = random.choice([n for n in HIRE_NAMES if n not in taken] or ["Newbie"])
        agent = dict(id=f"h{int(time.time())}", name=name, family=e["family"], params=e["params"], markets=e["markets"], tf=e.get("tf", "1d"),
                     founder=False, slot=slot, hired=time.time(), idea=e["name"], desc=describe(e["family"], e["params"]), mentor=mentor,
                     bt=e["result"], oos_pf=e["oos"]["pf"], color=random.randint(0, 9))
        f.roster.append(agent)
        f.names[agent["id"]] = name
        f.reallocate(announce=False)
        await f.say("boss", "hire", f"Welcome aboard, {name}! You'll trade \"{e['name']}\" on {len(e['markets'])} markets, daily bars. "
                    f"{' Hourly bars.' if e.get('tf') == '1h' else ''} Trust starts at 1.0. Earn it." + (f" {f.names.get(mentor, mentor)} invented it and will mentor you." if mentor else ""),
                    pause=3, target=agent["id"])
        await f.minds.on_career(agent["id"], "hired", f"Hired to trade {e['name']}" + (f", mentored by {f.names.get(mentor, mentor)}." if mentor else "."), xp=20, valence=1)
        if mentor and mentor != "jason":               # Jason designed it in the Strategy Builder: credit, but he has no AI mind
            await f.minds.on_career(mentor, "mentor", f"My idea {e['name']} got a new PM hired: {name}.", xp=50, valence=1)
        f.save()
        await f.push()

    async def fire(self, agent, why):
        f = self.floor
        for k in [k for k, p in f.broker.positions.items() if p["pod"] == agent["id"]]:
            px = f.desk.price(f.broker.positions[k]["sym"])
            if px:
                await f.exit(k, px, "PM fired")
        f.roster = [a for a in f.roster if a["id"] != agent["id"]]
        f.benched.discard(agent["id"])
        f.stopped.pop(agent["id"], None)
        f.reallocate(announce=False)
        await f.say("boss", "fire", f"{agent['name']}, pack your desk. {why}", pause=3, target=agent["id"])
        await f.minds.on_career(agent["id"], "fired", f"Fired: {why}"[:180], valence=-1)

    async def review(self):
        """Called after Sam grades. Fire hires that stopped working live; bench founders that lost their edge."""
        f = self.floor
        for a in list(f.roster):
            st = f.score.stats(a["id"])
            if not a.get("founder") and st["n"] >= C.FIRE_AFTER_CALLS and st["trust"] < C.FIRE_BELOW_TRUST:
                await self.fire(a, f"Live results: hit {st['hit']:.0%}, edge {st['edge_bps']:+.1f}bps. Not good enough.")
            elif a.get("founder") and a["id"] not in f.benched and st["n"] >= C.BENCH_FOUNDER_AFTER and st["trust"] < 0.5:
                f.benched.add(a["id"])
                await f.say("boss", "system", f"{a['name']}, your calls are losing money (edge {st['edge_bps']:+.1f}bps). You're benched until the lab finds better.")
                await f.minds.on_career(a["id"], "benched", "Benched for losing money. I need a better idea.", valence=-1)
