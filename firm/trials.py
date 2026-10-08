"""Trial and error: every PM keeps experimenting on their OWN strategy and gets better at experimenting.

Each round a PM walks to the backtest machine and tries a few changes to the factors of their strategy:
  tweak a setting, change the exits, add / drop / swap an entry filter (lego blocks), drop their worst market,
  add a market, change direction, add a volatility filter, or try an idea they picked up in the Study Hall.
Which KIND of change they try is learned: every PM keeps a win/loss record per kind of change and picks with
Thompson sampling, so over time they favor what has actually worked for them (and the firm keeps a shared record).

Honesty rules (so "getting smarter" is not just curve-fitting):
  - history is split: changes are judged on the TRAINING years, then must also hold up on the last HOLDOUT_YEARS
    the PM didn't tune on
  - an adopted version must still pass the lab's full hiring bar (significance, periods, drawdown, not a copy)
  - at most one adoption per PM per day; every experiment is logged with before/after numbers
Experiments never touch orders, sizing or risk limits; only the strategy definition, and only through vetted blocks."""
import asyncio
import copy
import math
import random
import time

import pandas as pd

from . import config as C
from .backtest import evaluate_daily, verdict_daily, fmt_daily
from .blocks import BLOCKS, INT_KEYS, clean_rules, describe_rules
from .strategies import FAMILIES, INT_PARAMS, clean, describe

HOLDOUT_YEARS = 3
TRIAL_EVERY_MIN = 12
TRIES_PER_ROUND = 4
ADOPT_COOLDOWN_H = 24
OPS = ["tweak", "exits", "add_filter", "drop_filter", "swap_filter", "drop_market", "add_market", "direction", "vol_filter", "idea", "timeframe"]
OP_LABEL = {"tweak": "tweak a setting", "exits": "change the exits", "add_filter": "add a filter", "drop_filter": "drop a filter",
            "swap_filter": "swap a filter", "drop_market": "drop my worst market", "add_market": "add a market",
            "direction": "change direction", "vol_filter": "add a volatility filter", "idea": "try a Study Hall idea",
            "timeframe": "switch timeframe (daily <-> 1-hour)"}
EXIT_KEYS = {"stop_atr", "trail_atr", "max_bars"}


def split_stats(res, cutoff):
    tr = res.get("trades")
    if tr is None or not len(tr):
        return dict(train_t=0.0, train_pf=0.0, train_n=0, hold_pf=0.0, hold_n=0, hold_ret=0.0)

    def st(r):
        r = r.values
        n = len(r)
        if n < 3 or r.std(ddof=1) == 0:
            return 0.0, 0.0, n, float(r.sum()) if n else 0.0
        g, l = r[r > 0].sum(), -r[r < 0].sum()
        return float(r.mean() / r.std(ddof=1) * math.sqrt(n)), float(g / l) if l > 0 else 9.99, n, float(r.sum())
    ex = tr.exit
    if getattr(ex.dt, "tz", None) is not None:
        ex = ex.dt.tz_convert(None)
    cut = pd.Timestamp(cutoff).tz_localize(None) if pd.Timestamp(cutoff).tzinfo else pd.Timestamp(cutoff)
    tt, tpf, tn, _ = st(tr[(ex < cut).values].ret)
    _, hpf, hn, hret = st(tr[(ex >= cut).values].ret)
    return dict(train_t=tt, train_pf=tpf, train_n=tn, hold_pf=hpf, hold_n=hn, hold_ret=hret)


def jitter(v, lo, hi, is_int):
    f = random.choice([random.uniform(0.6, 0.87), random.uniform(1.15, 1.6)])
    v = max(lo, min(hi, v * f if v else (lo + hi) / 4))
    return int(round(v)) if is_int else round(v, 2)


def rand_rule(block, near=None):
    p = {}
    for k, (lo, hi, d) in BLOCKS[block][1].items():
        base = (near or {}).get(k, d)
        p[k] = jitter(base, lo, hi, k in INT_KEYS) if random.random() < 0.7 else base
    return clean_rules([dict(block=block, params=p)])[0]


class Trials:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.people: dict = st.get("people", {})        # aid -> {ops: {op: [tries, wins]}, log: [], version, last_adopt, last_round}
        self.firm_ops: dict = st.get("firm_ops", {})
        self.ideas: dict = st.get("ideas", {})          # aid -> [Study Hall suggestions]
        self.next_at = time.time() + 5 * 60
        self.running = False
        self.current = None

    def to_state(self):
        return dict(people=self.people, firm_ops=self.firm_ops, ideas={k: v[-5:] for k, v in self.ideas.items()})

    def me(self, aid):
        return self.people.setdefault(aid, dict(ops={}, log=[], version=1, last_adopt=0, last_round=0))

    def eligible(self):
        f = self.floor
        return [a for a in f.roster if a["family"] in FAMILIES and a["family"] != "model" and a.get("tf") in ("1d", "1h")
                and (a["tf"] == "1d" or f.hdesk.bars)]

    async def maybe_run(self):
        f = self.floor
        if self.running or f.lab.running or time.time() < self.next_at or not f.lab.recertified:
            return
        pool = self.eligible()
        if not pool:
            return
        self.next_at = time.time() + TRIAL_EVERY_MIN * 60
        # whoever has a Study Hall idea waiting goes first; otherwise the PM who experimented least recently,
        # with a nudge toward PMs that are stopped / losing (they have the most to gain)
        def prio(a):
            st = f.score.stats(a["id"])
            return (bool(self.ideas.get(a["id"])), a["id"] in f.stopped, -self.me(a["id"])["last_round"] / 3600 - st["trust"])
        a = max(pool, key=prio)
        self.running = True
        asyncio.create_task(self._wrap(a))

    async def _wrap(self, a):
        f = self.floor
        try:
            await f.lab.ensure_history()
            await self._round(a)
        except Exception as e:     # never let an experiment crash the floor
            await f.say(a["id"], "chatter", f"Experiment blew up: {e!r}"[:140])
        finally:
            self.running, self.current = False, None
            f.save()
            await f.push()

    # ── choosing what to try: learned, not random ──
    def applicable(self, a):
        p, fam = a["params"], a["family"]
        filt = p.get("rules", []) if fam == "custom" else p.get("extra", [])
        cap = 3 if fam == "custom" else 2
        mk = a.get("markets") or C.DAILY_UNIVERSE
        ops = ["tweak", "exits", "direction"]
        if len(filt) < cap:
            ops.append("add_filter")
        if len(filt) > (1 if fam == "custom" else 0):
            ops.append("drop_filter")
        if filt:
            ops.append("swap_filter")
        if len(mk) > 6:
            ops.append("drop_market")
        if len(mk) < len(self.floor.lab.daily_syms()):
            ops.append("add_market")
        if fam != "custom":
            ops.append("vol_filter")
        if self.ideas.get(a["id"]):
            ops.append("idea")
        if self.floor.hdesk.bars:
            ops.append("timeframe")
        return ops

    def pick_op(self, a, used):
        ops = [o for o in self.applicable(a) if o not in used or o in ("tweak", "exits")]
        if "idea" in ops:
            return "idea"
        if "timeframe" in ops and not self.me(a["id"])["ops"].get("timeframe"):
            return "timeframe"           # everyone tries the other timeframe at least once
        mine = self.me(a["id"])["ops"]
        def sample(o):
            t, w = mine.get(o, [0, 0])
            ft, fw = self.firm_ops.get(o, [0, 0])
            # own experience first, the firm's shared experience as a weaker prior
            return random.betavariate(1 + w + 0.3 * fw, 1 + (t - w) + 0.3 * (ft - fw))
        return max(ops, key=sample)

    def mutate(self, a, op, base_res):
        fam, p = a["family"], copy.deepcopy(a["params"])
        mk = list(a.get("markets") or C.DAILY_UNIVERSE)
        tf = a.get("tf", "1d")
        spec = FAMILIES[fam]
        key = "rules" if fam == "custom" else "extra"
        filt = list(p.get(key) or [])
        what = ""
        if op == "tweak":
            knobs = [(k, r) for k, r in spec.items() if not isinstance(r[0], list) and k not in EXIT_KEYS and not k.startswith("vol_")]
            rule_knobs = [(i, k) for i, r in enumerate(filt) for k in r["params"]]
            if rule_knobs and (not knobs or random.random() < 0.5):
                i, k = random.choice(rule_knobs)
                lo, hi, _ = BLOCKS[filt[i]["block"]][1][k]
                old = filt[i]["params"][k]
                filt[i]["params"][k] = jitter(old, lo, hi, k in INT_KEYS)
                what = f"{filt[i]['block']} {k} {old}->{filt[i]['params'][k]}"
            elif knobs:
                k, (lo, hi, _) = random.choice(knobs)
                old = p[k]
                p[k] = jitter(old, lo, hi, k in INT_PARAMS)
                what = f"{k} {old}->{p[k]}"
        elif op == "exits":
            k = random.choice(sorted(EXIT_KEYS))
            lo, hi, _ = spec[k]
            old = p[k]
            p[k] = jitter(old, lo, hi, k in INT_PARAMS)
            what = f"{k} {old}->{p[k]}"
        elif op == "add_filter":
            have = {r["block"] for r in filt}
            b = random.choice([b for b in BLOCKS if b not in have])
            filt.append(rand_rule(b))
            what = f"add filter: {describe_rules(filt[-1:])}"
        elif op == "drop_filter":
            r = filt.pop(random.randrange(len(filt)))
            what = f"drop filter: {describe_rules([r])}"
        elif op == "swap_filter":
            i = random.randrange(len(filt))
            have = {r["block"] for r in filt}
            old = filt[i]
            filt[i] = rand_rule(random.choice([b for b in BLOCKS if b not in have]))
            what = f"swap {old['block']} for {describe_rules([filt[i]])}"
        elif op == "drop_market":
            tr = base_res.get("trades")
            if tr is None or not len(tr):
                return None
            by = tr.groupby("sym").ret.sum()
            worst = by.idxmin()
            mk = [m for m in mk if m != worst]
            what = f"drop {worst} (my worst market, {by.min():+.1%} total)"
        elif op == "add_market":
            pool = sorted(self.floor.hdesk.bars) if tf == "1h" else self.floor.lab.daily_syms()
            pool = [m for m in pool if m not in mk]
            if not pool:
                return None
            m = random.choice(pool)
            mk.append(m)
            what = f"add {m}"
        elif op == "direction":
            opts = [d for d in spec["direction"][0] if d != p.get("direction")]
            new = random.choice(opts)
            what = f"direction {p.get('direction')}->{new}"
            p["direction"] = new
        elif op == "vol_filter":
            if random.random() < 0.5:
                p["vol_min"], p["vol_max"] = 0.0, round(random.uniform(0.5, 0.9), 2)
                what = f"only trade when volatility rank < {p['vol_max']:.0%}"
            else:
                p["vol_min"], p["vol_max"] = round(random.uniform(0.1, 0.4), 2), 1.0
                what = f"only trade when volatility rank > {p['vol_min']:.0%}"
        elif op == "timeframe":
            new_tf = "1h" if tf == "1d" else "1d"
            hourly = set(self.floor.hdesk.bars)
            if new_tf == "1h":
                mk = [m for m in mk if m in hourly] or sorted(hourly)
            # either keep the same number of bars (a faster version) or keep the same holding time (scaled lengths)
            scale = random.choice([1.0, 7.0])
            if new_tf == "1d":
                scale = 1.0 / scale
            if scale != 1.0:
                for k, rule in spec.items():
                    if k in INT_PARAMS and not isinstance(rule[0], list):
                        lo, hi, _ = rule
                        p[k] = int(max(lo, min(hi, round(p[k] * scale))))
                for r in filt:
                    for k in r["params"]:
                        if k in INT_KEYS:
                            lo, hi, _ = BLOCKS[r["block"]][1][k]
                            r["params"][k] = int(max(lo, min(hi, round(r["params"][k] * scale))))
            what = f"switch to {'1-hour' if new_tf == '1h' else 'daily'} bars ({'same holding time' if scale != 1.0 else 'same bar counts'})"
            tf = new_tf
        elif op == "idea":
            idea = self.ideas[a["id"]].pop(0)
            if idea.get("block") in BLOCKS:
                filt = [r for r in filt if r["block"] != idea["block"]]
                filt.append(clean_rules([dict(block=idea["block"], params=idea.get("params") or {})])[0])
                filt = filt[-(3 if fam == "custom" else 2):]
            for k in EXIT_KEYS:
                if idea.get(k):
                    p[k] = idea[k]
            what = f"Study Hall idea ({idea.get('source', 'reading')[:40]}): {idea.get('why', '')[:90]}"
        if key == "rules":
            p["rules"] = filt
        elif filt:
            p["extra"] = filt
        else:
            p.pop("extra", None)
        return clean(fam, p), mk, what, tf

    # ── one round at the backtest machine ──
    async def _round(self, a):
        f = self.floor
        aid, name = a["id"], a["name"]
        me = self.me(aid)
        me["last_round"] = time.time()
        tf0 = a.get("tf", "1d")
        hist0 = f.lab.history_for(tf0)
        end = max(df.index[-1] for df in f.lab.daily.values())
        cutoff = pd.Timestamp(end) - pd.DateOffset(years=HOLDOUT_YEARS)
        mk0 = a.get("markets") or C.DAILY_UNIVERSE
        base = await asyncio.to_thread(evaluate_daily, hist0, a["family"], a["params"], mk0)
        bs = split_stats(base, cutoff)
        self.current = dict(agent=aid, name=name, desc=a.get("desc", ""), base=bs, tries=[])
        await f.say(aid, "experiment", f"Back to the backtest machine to improve my strategy (v{me['version']}). "
                    f"Training t={bs['train_t']:.1f}, last {HOLDOUT_YEARS}y PF {bs['hold_pf']:.2f}.", pause=4, step="go")
        best, used = None, set()
        for _ in range(TRIES_PER_ROUND):
            op = self.pick_op(a, used)
            used.add(op)
            m = self.mutate(a, op, base)
            if not m:
                continue
            params, mk, what, tf = m
            res = await asyncio.to_thread(evaluate_daily, f.lab.history_for(tf), a["family"], params, mk)
            cs = split_stats(res, cutoff)
            improved = cs["train_t"] >= bs["train_t"] + 0.25 and cs["train_pf"] >= bs["train_pf"] - 0.02
            holds = cs["hold_n"] >= 10 and cs["hold_pf"] >= max(1.1, bs["hold_pf"] - 0.05)
            win = improved and holds
            for book in (me["ops"], self.firm_ops):
                t = book.setdefault(op, [0, 0])
                t[0] += 1
                t[1] += int(win)
            verdict = "BETTER, and it holds up on recent data" if win else \
                "better on training data but FAILS on the recent years (curve-fit)" if improved else \
                "worse" if cs["train_t"] < bs["train_t"] - 0.1 else "no real gain"
            entry = dict(t=time.time(), op=op, what=what, before=round(bs["train_t"], 2), after=round(cs["train_t"], 2),
                         hold_pf=round(cs["hold_pf"], 2), win=win, verdict=verdict)
            me["log"] = (me["log"] + [entry])[-30:]
            self.current["tries"].append(entry)
            await f.say(aid, "experiment", f"Trial: {what}. -> {verdict} (t {bs['train_t']:.1f}->{cs['train_t']:.1f}, recent PF {cs['hold_pf']:.2f}).",
                        pause=3, ok=win)
            if win and (best is None or cs["train_t"] > best[3]["train_t"]):
                best = (params, mk, what, cs, res, op, tf)
        await self._conclude(a, me, best, base.get("cagr", 0.0))

    async def _conclude(self, a, me, best, base_cagr=0.0):
        f = self.floor
        aid, name = a["id"], a["name"]
        cooling = time.time() - me["last_adopt"] < ADOPT_COOLDOWN_H * 3600
        if best and not cooling:
            params, mk, what, cs, res, op, tf = best
            ok, reason = verdict_daily(res, f.lab.n_tests(), await asyncio.to_thread(f.lab.team_monthly, aid))
            if ok and base_cagr > 0 and res.get("cagr", 0) < 0.7 * base_cagr:
                ok, reason = False, f"it earns too little ({res.get('cagr', 0):+.1%}/yr vs {base_cagr:+.1%}/yr now)"
            if ok:
                me["version"] += 1
                me["last_adopt"] = time.time()
                if tf != a.get("tf"):
                    f.score.results[aid] = []           # a new timeframe is a new strategy: fresh live track record
                a.update(params=params, markets=mk, desc=describe(a["family"], params), bt=fmt_daily(res), oos_pf=res["all"]["pf"], tf=tf, since=time.time())
                f.reallocate(announce=False)
                await f.say(aid, "experiment", f"Adopting v{me['version']}: {what}. {reason}", pause=4, ok=True, step="done", adopted=True)
                await f.say("sam", "score", f"{name} upgraded their own strategy through trial and error (v{me['version']}). Logged.", pause=2)
                await f.minds.remember(aid, "experiment", f"Improved my strategy to v{me['version']} by trying: {what[:100]}", xp=35, valence=1)
            else:
                await f.say(aid, "experiment", f"Found something better but it doesn't clear the full bar ({reason}). Keeping v{me['version']}.",
                            pause=3, step="done")
                await f.minds.remember(aid, "experiment", f"Promising change ({what[:80]}) failed the full bar: {reason[:60]}", xp=6)
        else:
            why = "already upgraded today, saving it for tomorrow" if best else "nothing beat my current version"
            await f.say(aid, "experiment", f"Round done: {why}.", pause=2, step="done")
            await f.minds.remember(aid, "experiment", f"Experiment round: {why}.", xp=3)
        # turn the record into a lesson once there is enough evidence
        rec = [(o, t, w) for o, (t, w) in me["ops"].items() if t >= 6]
        if rec and random.random() < 0.35:
            o, t, w = max(rec, key=lambda x: x[2] / x[1]) if random.random() < 0.5 else min(rec, key=lambda x: x[2] / x[1])
            text = f"When I {OP_LABEL[o]}, it works {w}/{t} times."
            p = f.minds.get(aid)
            if not p["lessons"] or p["lessons"][-1]["text"] != text:
                p["lessons"] = (p["lessons"] + [dict(t=time.time(), text=text)])[-12:]

    def summary(self, aid):
        me = self.people.get(aid)
        if not me:
            return "no experiments yet"
        rec = ", ".join(f"{OP_LABEL[o]} {w}/{t}" for o, (t, w) in sorted(me["ops"].items(), key=lambda kv: -kv[1][0]))
        return f"v{me['version']}; what works: {rec or 'n/a'}"

    def queue_idea(self, aid, idea):
        self.ideas.setdefault(aid, []).append(idea)
        self.ideas[aid] = self.ideas[aid][-5:]

    def snapshot(self):
        f = self.floor
        people = {}
        for aid, me in self.people.items():
            people[aid] = dict(version=me["version"], ops={o: dict(tries=t, wins=w) for o, (t, w) in me["ops"].items()},
                               log=me["log"][-6:], ideas=len(self.ideas.get(aid, [])))
        return dict(people=people, firm_ops={o: dict(tries=t, wins=w) for o, (t, w) in self.firm_ops.items()},
                    current=self.current, running=self.running, next_in=max(0, int(self.next_at - time.time())),
                    labels=OP_LABEL, holdout_years=HOLDOUT_YEARS)
