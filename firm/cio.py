"""The CIO, version 2: a decision-maker instead of a rubber stamp, plus Jason's controls over the floor.

What the CIO does now:
  - Fund risk mode. Drawdown from the fund's high-water mark sets the stance: normal, defensive (-3%: new risk at 0.5x)
    or capital preservation (-6%: 0.25x, only trusted pods). Recovering above -1.5% returns to normal. Fund volatility
    targeting scales new risk by target / realized vol (0.6x-1.5x), so a calm fund takes MORE risk, a wild one less.
  - Trade reviews. Every PM signal gets a decision with reasons: PASS, or a size multiplier from the risk mode, Jason's
    mandate, the PM's form (on watch 0.5x, star 1.15x, Jason's boost 1.25x) and how the trade fits the book (piling into a
    group that's already 35%+ of NAV: 0.75x; diversifying: 1.1x). Every decision is logged with its outcome, and a
    scorecard shows whether the CIO's sizing added or cost money.
  - Performance reviews (every 6 hours). A PM's live R per trade is compared with what its backtest promised; 2 standard
    errors worse puts it on watch (half size) and sends it to Ava's lab first; 2 better makes it a star.
  - A morning plan at 9:00 New York time on weekdays.

What Jason does through it:
  - Floor announcements from the podium, with directives: a risk stance for the day (defensive / normal / press), a
    trading pause, a research sprint (a lab session every 20 minutes for a day), an all-hands huddle. The text becomes a
    standing priority for 7 days that goes into Ava's research brief, the team's reflections and pitches, what agents
    answer when asked, and the morning plan.
  - Team management: shout-outs (morale + XP), warnings (on watch), capital boosts, sending a PM to the lab."""
import asyncio
import math
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np

from . import config as C
from .llm import LLMError
from .riskbook import group_of

NY = ZoneInfo("America/New_York")
VOL_TARGET = float(getattr(C, "CIO_VOL_TARGET", 0.15))     # annualized fund volatility the CIO steers new risk toward
DD_DEFENSIVE, DD_PRESERVE, DD_RECOVER = -0.03, -0.06, -0.015
CROWDED_GROUP = 0.35
STANCE = {"defensive": 0.5, "normal": 1.0, "press": 1.25}
REACT_SYSTEM = ("You voice the AI employees of JB Capital, an AI-run hedge fund that PAPER trades. Jason, the 18-year-old founder, just made "
                "a floor announcement. Write 2-3 short, specific reactions (max 25 words each) from the listed agents, in character, "
                "saying what they will actually do differently. No hype, no promises of returns. Reply only with the JSON.")
REACT_SCHEMA = {"type": "object", "properties": {"reactions": {"type": "array", "maxItems": 3, "items": {
    "type": "object", "properties": {"agent": {"type": "string"}, "line": {"type": "string"}}, "required": ["agent", "line"],
    "additionalProperties": False}}}, "required": ["reactions"], "additionalProperties": False}


def next_close(now=None):
    """The next 4:00 pm New York time (a mandate 'for the day' lasts until then)."""
    t = datetime.fromtimestamp(now or time.time(), NY)
    c = t.replace(hour=16, minute=0, second=0, microsecond=0)
    if t >= c:
        c += timedelta(days=1)
    while c.weekday() >= 5:
        c += timedelta(days=1)
    return c.timestamp()


def hhmm(ts):
    t = datetime.fromtimestamp(ts, NY)
    return f"{t:%a} {t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'} ET"


class CIO:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.mode = st.get("mode", "normal")
        self.mandate = st.get("mandate")                  # {stance, until, t}
        self.pause_until = st.get("pause_until", 0.0)
        self.watch = st.get("watch", {})                  # pod -> {why, until, by, t}
        self.star = st.get("star", {})                    # pod -> {why, until}
        self.boost = st.get("boost", {})                  # pod -> {mult, until}
        self.decisions = st.get("decisions", [])[-300:]
        self.priorities = st.get("priorities", [])
        self.announcements = st.get("announcements", [])[-30:]
        self.plan, self.plan_day = st.get("plan"), st.get("plan_day")
        self.sprint_until = st.get("sprint_until", 0.0)
        self.lab_focus = st.get("lab_focus")
        self.beta = {}                                    # pod -> why (set at re-certification: entries don't beat random)
        self.review_at = 0.0
        self.reacting = False
        self.react_day, self.react_n = None, 0

    def to_state(self):
        return dict(mode=self.mode, mandate=self.mandate, pause_until=self.pause_until, watch=self.watch, star=self.star, boost=self.boost,
                    decisions=self.decisions[-300:], priorities=self.priorities, announcements=self.announcements[-30:], plan=self.plan,
                    plan_day=self.plan_day, sprint_until=self.sprint_until, lab_focus=self.lab_focus)

    # ── the fund's risk stance ──
    def fund(self, fresh=False):
        now = time.time()
        if not fresh and getattr(self, "_fund", None) and now - self._fund[0] < 20:
            return self._fund[1]
        out = self._fund_calc(now)
        self._fund = (now, out)
        return out

    def _fund_calc(self, now):
        f = self.f
        eq = f.broker.equity(f.prices())
        vals = [c[1] for c in f.curve[-60000:]] + [eq]
        hwm = max(vals + [C.STARTING_CASH])
        dd = eq / hwm - 1
        if dd <= DD_PRESERVE:
            mode = "preservation"
        elif dd <= DD_DEFENSIVE:
            mode = "defensive" if self.mode != "preservation" or dd > DD_PRESERVE * 0.75 else "preservation"
        elif dd > DD_RECOVER:
            mode = "normal"
        else:
            mode = self.mode if self.mode != "preservation" else "defensive"
        vol, vol_mult = None, 1.0
        days = {}
        for t, v in f.curve[-60000:]:
            days[datetime.fromtimestamp(t, NY).date()] = v
        closes = list(days.values())[-21:]
        if len(closes) >= 11:
            r = np.diff(closes) / np.array(closes[:-1])
            if r.std() > 0:
                vol = float(r.std() * math.sqrt(252))
                vol_mult = float(min(1.5, max(0.6, VOL_TARGET / vol)))
        mand = self.mandate if self.mandate and self.mandate["until"] > now else None
        mult = {"normal": 1.0, "defensive": 0.5, "preservation": 0.25}[mode] * vol_mult * (STANCE[mand["stance"]] if mand else 1.0)
        return dict(mode=mode, dd=dd, hwm=hwm, vol=vol, vol_mult=vol_mult, mandate=mand, mult=float(min(1.6, max(0.2, mult))),
                    paused=self.pause_until > now, pause_until=self.pause_until if self.pause_until > now else 0)

    def paused(self):
        return self.pause_until > time.time()

    # ── trade reviews ──
    def review(self, a, inst, side, view_disagrees=False):
        """-> (multiplier, reasons, verdict). verdict is 'PASS' or 'APPROVED'."""
        f, now = self.f, time.time()
        pod, s = a["id"], inst["sym"]
        if self.paused():
            return 0.0, [f"trading is paused by Jason until {hhmm(self.pause_until)}"], "PASS"
        F = self.fund()
        m, why = F["mult"], []
        if F["mode"] != "normal":
            why.append(f"fund is in {F['mode']} mode (drawdown {F['dd']:.1%})")
        if abs(F["vol_mult"] - 1) > 0.05:
            why.append(f"fund vol {F['vol']:.0%} vs target {VOL_TARGET:.0%}: {F['vol_mult']:.2f}x")
        if F["mandate"]:
            why.append(f"Jason's mandate: {F['mandate']['stance']}")
        if F["mode"] == "preservation" and f.score.stats(pod)["trust"] < 1.0:
            return 0.0, why + ["capital preservation: only trusted PMs trade"], "PASS"
        w = self.watch.get(pod)
        if w and w["until"] > now:
            m *= 0.5
            why.append(f"{a['name']} is on watch ({w['why'][:60]})")
        if pod in self.beta:
            m *= 0.5
            why.append("entries don't beat random: treated as beta, half size")
        st = self.star.get(pod)
        if st and st["until"] > now:
            m *= 1.15
            why.append(f"{a['name']} is a star: live results beat the backtest")
        b = self.boost.get(pod)
        if b and b["until"] > now:
            m *= b["mult"]
            why.append(f"Jason's conviction boost {b['mult']:.2f}x")
        px = f.prices()
        eq = f.broker.equity(px) or 1.0
        _, by_grp = f.riskbook.exposure(px)
        g = group_of(s)
        have = side * by_grp.get(g, 0.0) / eq
        if have >= CROWDED_GROUP:
            m *= 0.75
            why.append(f"adds to {g}, already {have:.0%} of NAV")
        elif have <= 0:
            m *= 1.1
            why.append(f"diversifies the book ({g} {'empty' if have == 0 else 'is net the other way'})")
        if view_disagrees:
            m *= 0.5
            why.append("Ava's market view disagrees")
        m = float(min(1.6, max(0.0, m)))
        if m < 0.2:
            return m, why, "PASS"
        return m, why, "APPROVED"

    def log(self, pod, sym, side, mult, why, verdict, key=None):
        self.decisions.append(dict(t=time.time(), pod=pod, name=self.f.names.get(pod, pod), sym=sym, side=side, mult=round(mult, 3),
                                   why=why[:5], verdict=verdict, key=key, out=None))
        if len(self.decisions) > 350:
            del self.decisions[:-300]

    def on_close(self, key, tr):
        for d in reversed(self.decisions):
            if d.get("key") == key and d["out"] is None and d["t"] <= tr.get("opened", time.time()) + 120:
                d["out"] = dict(pnl=round(tr["pnl"], 2), r=round(tr["r"], 3) if tr.get("r") is not None else None)
                return

    def scorecard(self):
        done = [d for d in self.decisions if d.get("out")]
        def bucket(lo, hi):
            xs = [d for d in done if lo <= d["mult"] < hi]
            rs = [d["out"]["r"] for d in xs if d["out"]["r"] is not None]
            return dict(n=len(xs), pnl=round(sum(d["out"]["pnl"] for d in xs), 2), avg_r=round(sum(rs) / len(rs), 3) if rs else None)
        added = sum(d["out"]["pnl"] - d["out"]["pnl"] / d["mult"] for d in done if d["mult"] > 0)
        return dict(cut=bucket(0, 0.95), full=bucket(0.95, 1.05), boosted=bucket(1.05, 9), added=round(added, 2), n=len(done),
                    passes=sum(1 for d in self.decisions if d["verdict"] == "PASS"))

    # ── performance reviews: live results vs what the backtest promised ──
    async def reviews(self):
        f, now = self.f, time.time()
        for d in (self.watch, self.star, self.boost):
            for k in [k for k, v in d.items() if v["until"] <= now or k not in f.ids()]:
                d.pop(k)
        for a in f.roster:
            aid = a["id"]
            dial = f.toolbox.dials.get(aid)
            if a["family"] == "options" or not dial or not dial.get("r_sd"):
                continue
            rs = [t["r"] for t in f.broker.trades if t.get("pod") == aid and t.get("r") is not None and not t.get("trim")
                  and t.get("opened", 0) >= a.get("since", 0)]
            if len(rs) < 8:
                continue
            mean, exp = sum(rs) / len(rs), dial["edge"]
            z = (mean - exp) / (dial["r_sd"] / math.sqrt(len(rs)))
            why = f"live {mean:+.2f}R per trade over {len(rs)} trades vs backtest {exp:+.2f}R (z={z:+.1f})"
            w = self.watch.get(aid)
            if z < -2 and not w:
                self.watch[aid] = dict(why=why, until=now + 7 * 86400, by="cio", t=now)
                self.lab_focus = aid
                await f.say("boss", "system", f"{a['name']} goes on watch: {why}. Half size until it recovers; Ava, look at it first.", pause=2, target=aid)
            elif w and w.get("by") == "cio" and z > -1:
                self.watch.pop(aid)
                await f.say("boss", "system", f"{a['name']} is off watch: {why}. Back to full size.", pause=1, target=aid)
            if z > 2 and aid not in self.star:
                self.star[aid] = dict(why=why, until=now + 7 * 86400)
                await f.say("boss", "praise", f"{a['name']} is beating its own backtest: {why}. Star status: 1.15x on new trades this week.", pause=2, target=aid)

    # ── the morning plan ──
    async def maybe_plan(self, force=False):
        f = self.f
        t = datetime.now(NY)
        day = t.strftime("%Y-%m-%d")
        if not force and (self.plan_day == day or t.weekday() >= 5 or not (9 <= t.hour < 16)):
            return
        self.plan_day = day
        F = self.fund()
        px = f.prices()
        eq = f.broker.equity(px) or 1.0
        _, by_grp = f.riskbook.exposure(px)
        lines = [f"Risk mode: {F['mode'].upper()} (drawdown {F['dd']:.1%}"
                 + (f", fund vol {F['vol']:.0%}" if F["vol"] is not None else ", vol: not enough history yet")
                 + f"). New trades size at {F['mult']:.2f}x."]
        if F["mandate"]:
            lines.append(f"Jason's mandate: {F['mandate']['stance']} until {hhmm(F['mandate']['until'])}.")
        if F["paused"]:
            lines.append(f"New entries paused until {hhmm(self.pause_until)}.")
        pr = self.active_priorities()
        if pr:
            lines.append("Priorities from Jason: " + "; ".join(p["text"].rstrip(".!") for p in pr) + ".")
        big = sorted(by_grp.items(), key=lambda kv: -abs(kv[1]))[:3]
        if big:
            lines.append("Biggest exposures: " + ", ".join(f"{g} {v / eq:+.0%}" for g, v in big)
                         + f" (cap {C.MAX_GROUP_NOTIONAL:.0%} per group: Rex trims anything over at the open).")
        w = [f"{f.names.get(k, k)} ({v['why'][:50]})" for k, v in self.watch.items()]
        if w:
            lines.append("On watch: " + "; ".join(w) + ".")
        s = [f.names.get(k, k) for k in self.star]
        if s:
            lines.append("Stars: " + ", ".join(s) + ".")
        top = sorted(((f.names.get(i, i), x) for i, x in f.alloc.items() if x > 0), key=lambda x: -x[1])[:4]
        if top:
            lines.append("Capital: " + ", ".join(f"{n} {x:.0%}" for n, x in top) + ".")
        if f.headline:
            lines.append(f"Ava's view: {f.headline[:140]}")
        if f.riskrep.line():
            lines.append("Risk: " + f.riskrep.line())
        self.plan = dict(t=time.time(), day=day, lines=lines)
        if not force:                                 # 9:00: the morning meeting (the team gathers in the meeting room)
            await f.say("boss", "meeting", "Morning meeting, everyone. Meeting room, now.", pause=2)
            asyncio.create_task(f.huddle())
        await f.say("boss", "meeting", "Morning plan. " + " ".join(lines[:3])[:400], pause=2)

    async def tick(self):
        if time.time() >= self.review_at:
            self.review_at = time.time() + 6 * 3600
            await self.reviews()
        await self.maybe_plan()
        F = self.fund()
        if F["mode"] != self.mode:
            old, self.mode = self.mode, F["mode"]
            msg = {"defensive": f"Fund drawdown {F['dd']:.1%}: switching to DEFENSIVE. New risk at half size until we recover past {DD_RECOVER:.1%}.",
                   "preservation": f"Fund drawdown {F['dd']:.1%}: CAPITAL PRESERVATION. Only trusted PMs trade, at a quarter size.",
                   "normal": f"Drawdown back to {F['dd']:.1%}: risk mode NORMAL again (was {old})."}[self.mode]
            await self.f.say("boss", "risk", msg, pause=2, ok=self.mode == "normal")

    # ── Jason's floor announcements and priorities ──
    def active_priorities(self):
        now = time.time()
        self.priorities = [p for p in self.priorities if p["until"] > now]
        return self.priorities

    def priorities_line(self):
        pr = self.active_priorities()
        if not pr:
            return ""
        return ("## Founder's priorities (Jason, the owner, announced these to the whole floor: weigh them in what you do)\n"
                + "\n".join(f"- \"{p['text']}\" (set {datetime.fromtimestamp(p['t'], NY):%b %d})" for p in pr) + "\n")

    async def announce(self, msg):
        f, now = self.f, time.time()
        text = " ".join(str(msg.get("text", "")).split())[:280]
        stance, pause = msg.get("stance"), msg.get("pause")
        sprint, huddle = bool(msg.get("sprint")), bool(msg.get("huddle"))
        if not text and not (stance or pause or sprint or huddle):
            return
        did = []
        if stance in STANCE:
            self.mandate = None if stance == "normal" else dict(stance=stance, until=next_close(), t=now)
            did.append({"defensive": "defensive stance until the close: new trades at half size",
                        "press": "press stance until the close: new trades at 1.25x, inside every limit",
                        "normal": "normal stance"}[stance])
        if pause in ("1h", "close"):
            self.pause_until = now + 3600 if pause == "1h" else next_close()
            did.append(f"no new entries until {hhmm(self.pause_until)} (stops and exits keep running)")
        elif pause == "resume":
            self.pause_until = 0.0
            did.append("trading resumed")
        if sprint:
            self.sprint_until = now + 86400
            f.lab.next_at = 0
            f.trials.next_at = 0
            did.append("research sprint: a lab session every 20 minutes for the next 24 hours")
        if text and msg.get("priority", True):
            self.priorities.append(dict(id=f"p{int(now * 1000) % 10**9}", t=now, text=text, until=now + 7 * 86400))
            self.priorities = self.priorities[-6:]
        self.announcements.append(dict(t=now, text=text, did=did))
        await f.say("jason", "announce", text or "Listen up, team.", pause=2.5, did=did)
        if did:
            txt = "; ".join(did)
            await f.say("boss", "decision", f"You heard Jason. {txt[0].upper()}{txt[1:]}.", pause=2)
        self._fund = None
        if huddle:
            asyncio.create_task(f.huddle())
        if sprint:
            asyncio.create_task(f.lab.maybe_run())
        asyncio.create_task(self.react(text, did))
        f.save()
        await f.push()

    async def react(self, text, did):
        f = self.f
        if self.reacting:
            return
        self.reacting = True
        try:
            today = time.strftime("%Y-%m-%d")
            if self.react_day != today:
                self.react_day, self.react_n = today, 0
            who = ["ava", "rex"] + [a["id"] for a in f.roster if a["id"] not in f.benched][:4]
            lines = []
            if f.brain.enabled and self.react_n < 30 and text:
                self.react_n += 1
                roster = "\n".join(f"- {i} = {f.names.get(i, i)}" + (f" (PM: {next((a.get('desc') for a in f.roster if a['id'] == i), '')[:80]})" if i not in ("ava", "rex") else
                                                                    " (Head of Research)" if i == "ava" else " (Chief Risk Officer)") for i in who)
                try:
                    out = await asyncio.to_thread(f.brain.ask, REACT_SYSTEM, f"Announcement: \"{text}\"\nDirectives applied: {'; '.join(did) or 'none'}\n"
                                                  f"Fund: {f.status_text()[:400]}\nAgents (use these ids):\n{roster}", REACT_SCHEMA, 120)
                    lines = [(r["agent"], r["line"][:200]) for r in out.get("reactions", []) if r.get("agent") in who][:3]
                except LLMError:
                    lines = []
            if not lines:
                low = (text or "").lower()
                if any(k in low for k in ("edge", "research", "strateg", "alpha", "idea")) or any("research" in d for d in did):
                    lines.append(("ava", "On it. More lab sessions, and I'll favor ideas unlike anything we already run."))
                if any(k in " ".join(did) for k in ("half size", "1.25x", "no new entries")):
                    lines.append(("rex", "Understood. Every limit still applies, and I'll still veto crowded trades."))
                if not lines:
                    lines.append(("boss", "Noted, Jason. It's on the plan."))
            await asyncio.sleep(3)
            for aid, line in lines:
                await f.say(aid, "chat", line, pause=2.5, to="floor")
        finally:
            self.reacting = False

    async def manage(self, msg):
        f, now = self.f, time.time()
        aid, act = str(msg.get("agent", "")), str(msg.get("action", ""))
        note = " ".join(str(msg.get("note", "")).split())[:160]
        a = next((x for x in f.roster if x["id"] == aid), None)
        if not a:
            return
        name = a["name"]
        mind = f.minds.get(aid)
        if act == "shout":
            mind["mood"] = "fired up"
            await f.minds.on_career(aid, "praise", f"Jason gave me a shout-out in front of the floor{': ' + note if note else ''}.", xp=25, valence=1)
            await f.say("jason", "announce", f"Shout-out to {name}" + (f": {note}" if note else ". Great work.") , pause=2, did=[], target=aid, praise=True)
            await f.say(aid, "chat", "Thanks, Jason. Means a lot. Back to it.", pause=1, to="jason")
        elif act == "warn":
            self.watch[aid] = dict(why="Jason's warning" + (f": {note}" if note else ""), until=now + 5 * 86400, by="jason", t=now)
            mind["mood"] = "uneasy"
            await f.minds.on_career(aid, "warning", f"Jason put me on watch{': ' + note if note else ''}.", xp=0, valence=-1)
            await f.say("boss", "system", f"{name} is on watch (Jason's call{': ' + note if note else ''}): half size on new trades for 5 days.", pause=2, target=aid)
        elif act == "unwatch":
            if self.watch.pop(aid, None):
                await f.say("boss", "system", f"{name} is off watch. Full size again.", pause=1, target=aid)
        elif act == "boost":
            self.boost[aid] = dict(mult=1.25, until=now + 5 * 86400)
            mind["mood"] = "confident"
            await f.say("boss", "system", f"Jason's conviction boost for {name}: new trades at 1.25x for 5 days (still inside every limit).", pause=2, target=aid)
        elif act == "unboost":
            if self.boost.pop(aid, None):
                await f.say("boss", "system", f"{name}'s boost is off.", pause=1, target=aid)
        elif act == "lab":
            self.lab_focus = aid
            f.lab.next_at = 0
            await f.say("ava", "research", f"Jason wants {name}'s strategy re-examined. It's first in line at the lab.", pause=1)
            asyncio.create_task(f.lab.maybe_run())
        else:
            return
        f.save()
        await f.push()

    def snapshot(self):
        F = self.fund()
        now = time.time()
        names = self.f.names
        return dict(fund=F, vol_target=VOL_TARGET, plan=self.plan, scorecard=self.scorecard(),
                    decisions=self.decisions[-25:][::-1],
                    watch={k: dict(v, name=names.get(k, k)) for k, v in self.watch.items() if v["until"] > now},
                    star={k: dict(v, name=names.get(k, k)) for k, v in self.star.items() if v["until"] > now},
                    boost={k: dict(v, name=names.get(k, k)) for k, v in self.boost.items() if v["until"] > now},
                    beta={k: dict(why=v, name=names.get(k, k)) for k, v in self.beta.items()},
                    priorities=self.active_priorities(), announcements=self.announcements[-8:][::-1],
                    sprint_until=self.sprint_until if self.sprint_until > now else 0, lab_focus=names.get(self.lab_focus) if self.lab_focus else None)
