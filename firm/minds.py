"""Minds: what makes the agents behave like people instead of scripts.

Every agent has a personality, a memory of what happened to them (trades won and lost, ideas that passed or
failed, being hired / benched / upgraded), XP and a career ladder, a mood, a current goal and a journal.
A few times a day the team REFLECTS (Claude, one call for everyone): each agent reads their own memories and
writes a journal entry, distills a lesson, sets a new goal, and may:
  - PITCH a brand-new strategy built from the lego kit (firm/blocks.py) -> the lab tests it under the same strict bar
  - REQUEST a new tool (data feed, building block) -> posted to Jason on the Wire; he (or Claude Code) builds it
Lessons flow back into every research session, so the firm's knowledge compounds over time.

Safety: minds never touch orders, sizing or risk limits. Pitches only become trades after passing the backtest gate,
and everything stays paper until Jason says otherwise."""
import asyncio
import random
import time

from .blocks import BLOCKS, block_schema, catalog, clean_rules, describe_rules
from .llm import LLMError

LEVELS = [(0, "Rookie"), (100, "Junior"), (300, "Associate"), (700, "VP"), (1500, "Director"), (3000, "Partner")]
REFLECT_EVERY_H = 8
FIRST_REFLECT_MIN = 12

PERSONAS = {
    "boss": ("CIO", "calm, demanding, allocates capital only to proven results"),
    "rex": ("CRO", "paranoid about risk, dry humor, says no a lot"),
    "eddie": ("Execution", "fast, precise, obsessed with fees and slippage"),
    "dot": ("Data", "meticulous, hates bad data, quietly proud of clean pipelines"),
    "vic": ("Volatility", "moody like the markets he watches, thinks in regimes"),
    "sam": ("Scorekeeper", "blunt, numbers-only, nobody's friend and everybody's referee"),
    "ava": ("Head of Research", "curious scientist, skeptical of her own ideas, loves a clean experiment"),
    "mo": ("PM · trend", "aggressive trend chaser, loves new highs, hates choppy markets"),
    "rita": ("PM · mean reversion", "contrarian, patient, buys fear"),
    "opal": ("PM · options", "careful vol trader, thinks in probabilities"),
    "lena": ("Chief Compliance Officer", "precise, calm, rules apply to everyone including the founder"),
    "ari": ("Front desk", "warm, organized, knows where everyone is"),
    "kai": ("ML Quant Researcher", "rigorous, distrusts any backtest until it survives out of sample, explains models plainly"),
}
HIRE_TRAITS = ["hungry rookie, wants to prove the backtest was not luck", "quiet grinder, studies every losing trade",
               "competitive, watches the leaderboard", "creative tinkerer, always combining ideas",
               "disciplined, sticks to the rules even when bored", "optimistic, a little overconfident"]
MOODS = ["fired up", "confident", "focused", "uneasy", "frustrated"]

REFLECT_SYSTEM = (
    "You write the inner lives of the AI employees of JB Capital, a small AI-run quant fund that PAPER trades for its "
    "founder Jason. Each agent reflects like a real professional: honest about mistakes, specific about evidence, "
    "growing over time. Lessons must be grounded in the memories and numbers you are given (no invented results). "
    "Pitches must be NEW strategies built only from the lego blocks listed, aimed at making money after costs, and "
    "different from what is already in the research log. Tool requests must be concrete things a developer could "
    "build (a data feed, a new block, a report) with a clear money reason. Reply only with the JSON.")


def level_of(xp):
    i = max(i for i, (need, _) in enumerate(LEVELS) if xp >= need)
    nxt = LEVELS[i + 1][0] if i + 1 < len(LEVELS) else None
    return i, LEVELS[i][1], nxt


class Minds:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.m: dict = st.get("people", {})
        self.firm_lessons: list = st.get("firm_lessons", [])
        self.pitches: list = st.get("pitches", [])        # queued strategy ideas from the team, tested by the lab
        self.requests: list = st.get("requests", [])      # tool requests sent to Jason
        self.last_reflect = st.get("last_reflect", time.time() - (REFLECT_EVERY_H * 3600 - FIRST_REFLECT_MIN * 60))
        self.reflecting = False

    def to_state(self):
        return dict(people=self.m, firm_lessons=self.firm_lessons[-25:], pitches=self.pitches[-20:],
                    requests=self.requests[-30:], last_reflect=self.last_reflect)

    # ── one person ──
    def get(self, aid):
        if aid not in self.m:
            role, traits = PERSONAS.get(aid, ("PM", random.choice(HIRE_TRAITS)))
            self.m[aid] = dict(role=role, traits=traits, xp=0, mood="focused", goal="", journal=[], lessons=[],
                               memories=[], wins=0, losses=0, pnl=0.0, passed=0, failed=0, pitched=0, born=time.time())
        return self.m[aid]

    async def remember(self, aid, kind, text, xp=0, valence=0):
        if not aid or aid == "jason":
            return
        p = self.get(aid)
        p["memories"] = (p["memories"] + [dict(t=time.time(), kind=kind, text=str(text)[:200], v=valence)])[-40:]
        before = level_of(p["xp"])[0]
        p["xp"] = max(0, p["xp"] + xp)
        lvl, title, _ = level_of(p["xp"])
        if lvl > before:
            name = self.floor.names.get(aid, aid)
            p["memories"].append(dict(t=time.time(), kind="promotion", text=f"Promoted to {title}.", v=1))
            await self.floor.say("boss", "promotion", f"Promotion: {name} is now {title}. Earned it.", pause=2, target=aid)

    # ── event hooks (called by the floor and the lab) ──
    async def on_trade(self, tr):
        aid, pnl = tr["pod"], tr["pnl"]
        p = self.get(aid)
        p["pnl"] += pnl
        win = pnl > 0
        p["wins" if win else "losses"] += 1
        await self.remember(aid, "trade", f"{'Won' if win else 'Lost'} ${abs(pnl):,.0f} on {tr['sym']} ({tr.get('reason', '')}).",
                            xp=(10 + min(40, pnl / 50)) if win else 2, valence=1 if win else -1)

    async def on_research(self, entry, author="ava", pitched_by=None):
        ok = entry["passed"]
        tag = f"{entry['name']}: {entry['family']}" + (f" [{describe_rules(entry['params']['rules'])}]" if entry["family"] == "custom" else "")
        for aid in {author, pitched_by} - {None}:
            p = self.get(aid)
            p["passed" if ok else "failed"] += 1
            await self.remember(aid, "research", f"{'PASSED' if ok else 'FAILED'} {tag[:120]} -> {entry['reason'][:80]}",
                                xp=60 if ok else 4, valence=1 if ok else 0)

    async def on_career(self, aid, kind, text, xp=0, valence=0):
        await self.remember(aid, kind, text, xp=xp, valence=valence)

    # ── what the lab reads: the firm's growing knowledge ──
    def block_scoreboard(self, log):
        """Which lego blocks have actually produced passing strategies so far."""
        tally = {}
        for e in log:
            if e.get("family") != "custom" or e.get("tf") not in ("1d", "1h"):
                continue
            for r in e["params"].get("rules", []):
                t = tally.setdefault(r["block"], [0, 0])
                t[0 if e["passed"] else 1] += 1
        return tally

    def knowledge_brief(self, log):
        lines = [f"- {l['text']} ({self.floor.names.get(l.get('by'), l.get('by', 'firm'))})" for l in self.firm_lessons[-8:]]
        for aid, p in self.m.items():
            for l in p["lessons"][-2:]:
                lines.append(f"- {self.floor.names.get(aid, aid)}: {l['text']}")
        tally = self.block_scoreboard(log)
        board = ", ".join(f"{b} {w}/{w + l} passed" for b, (w, l) in sorted(tally.items(), key=lambda kv: -kv[1][0]))
        return ("## What the team has learned so far (from their own experience)\n" + ("\n".join(lines[-14:]) or "- nothing yet") +
                (f"\nLego block track record: {board}" if board else ""))

    def next_pitch(self):
        return self.pitches.pop(0) if self.pitches else None

    # ── reflection ──
    async def maybe_reflect(self, force=False):
        if self.reflecting or (not force and time.time() - self.last_reflect < REFLECT_EVERY_H * 3600):
            return
        self.reflecting = True
        self.last_reflect = time.time()
        asyncio.create_task(self._reflect())

    def _people(self):
        f = self.floor
        ids = [a["id"] for a in f.roster] + ["ava", "boss", "rex", "vic", "eddie", "dot", "sam"]
        return [i for i in dict.fromkeys(ids)]

    def _prompt(self):
        f = self.floor
        snap = f.snapshot()
        pods = {p["id"]: p for p in snap["roster"]}
        rows = []
        for aid in self._people():
            p = self.get(aid)
            _, title, _ = level_of(p["xp"])
            pod = pods.get(aid)
            job = f"{pod['desc']} ({pod['status']}, alloc {pod['alloc']:.0%}, pod P&L ${pod['pnl']:,.0f}, trust {pod['stats']['trust']:.2f})" if pod else p["role"]
            mem = "; ".join(m["text"] for m in p["memories"][-8:]) or "nothing notable yet"
            les = "; ".join(l["text"] for l in p["lessons"][-3:]) or "none yet"
            if pod and aid in f.trials.people:
                job += f" | trial-and-error: {f.trials.summary(aid)}"
            rows.append(f"### {aid} = {f.names.get(aid, aid)} ({p['role']}, {title}, {p['xp']} XP)\nPersonality: {p['traits']}\nJob: {job}\n"
                        f"Record: {p['wins']}W/{p['losses']}L, ${p['pnl']:,.0f} realized, ideas {p['passed']} passed / {p['failed']} failed\n"
                        f"Mood: {p['mood']}. Goal: {p['goal'] or 'none yet'}\nRecent memories: {mem}\nLessons so far: {les}")
        log = [e for e in f.lab.log if e.get("tf") in ("1d", "1h")][-12:]
        tested = "\n".join(f"- [{'PASS' if e['passed'] else 'FAIL'}] {e['name']}: {e['family']} "
                           f"{describe_rules(e['params']['rules']) if e['family'] == 'custom' else e['params']} -> {e['reason'][:90]}" for e in log)
        reqs = "\n".join(f"- {r['by']}: {r['what']} ({r['status']})" for r in self.requests[-8:]) or "- none"
        return (f"Fund: NAV {snap['nav']:.2f}, equity ${snap['equity']:,.0f}, today {snap['day_ret']:+.2%}, max DD {snap['maxdd']:.1%}.\n\n"
                + f.cio.priorities_line() + "\n"
                + "\n\n".join(rows) +
                f"\n\n## Research log (recent)\n{tested or '- nothing yet'}\n\n{self.knowledge_brief(f.lab.log)}\n{f.overlap.brief_line()}\n{f.toolbox.brief_line()}\n{f.incubator.brief_line()}\n\n"
                f"## Lego blocks for pitches (1-3 rules, ALL must be true to enter; shorts mirror)\n{catalog()}\n"
                f"Markets: {', '.join(f.lab.daily_syms())}\n\n## Tool requests already sent\n{reqs}\n\n"
                "Write one reflection per agent listed (use their id). Then, only if someone has a genuinely new, evidence-driven "
                "idea, add up to 2 strategy pitches (pitched by a PM or Ava) and at most 1 tool request. Add one firm-wide lesson.")

    def _schema(self):
        f = self.floor
        ids = self._people()
        syms = f.lab.daily_syms()
        return {"type": "object", "properties": {
            "people": {"type": "array", "items": {"type": "object", "properties": {
                "id": {"type": "string", "enum": ids},
                "journal": {"type": "string", "description": "first person, max 40 words, specific"},
                "lesson": {"type": "string", "description": "a new lesson learned from evidence, max 25 words, or empty"},
                "goal": {"type": "string", "description": "next concrete goal, max 15 words"},
                "mood": {"type": "string", "enum": MOODS}},
                "required": ["id", "journal", "lesson", "goal", "mood"], "additionalProperties": False}},
            "pitches": {"type": "array", "maxItems": 2, "items": {"type": "object", "properties": {
                "by": {"type": "string", "enum": ids},
                "name": {"type": "string", "description": "catchy, max 4 words"},
                "rules": {"type": "array", "minItems": 1, "maxItems": 3, "items": block_schema()},
                "direction": {"type": "string", "enum": ["long", "short", "both"]},
                "stop_atr": {"type": "number"}, "trail_atr": {"type": "number"}, "max_bars": {"type": "number"},
                "markets": {"type": "array", "items": {"type": "string", "enum": syms}},
                "hypothesis": {"type": "string", "description": "why it should make money, max 25 words"},
                "failure_mode": {"type": "string", "description": "max 15 words"}},
                "required": ["by", "name", "rules", "direction", "markets", "hypothesis", "failure_mode"], "additionalProperties": False}},
            "tool_request": {"type": "object", "properties": {
                "by": {"type": "string", "enum": ids},
                "what": {"type": "string", "description": "the tool to build, max 20 words, or empty if none"},
                "why": {"type": "string", "description": "how it helps make money, max 30 words"}},
                "required": ["by", "what", "why"], "additionalProperties": False},
            "firm_lesson": {"type": "string", "description": "one lesson for the whole firm, max 25 words"}},
            "required": ["people", "pitches", "tool_request", "firm_lesson"], "additionalProperties": False}

    async def _reflect(self):
        f = self.floor
        try:
            await f.say("boss", "reflect", "End of shift. Everyone, write up what you learned.", pause=2)
            if f.brain.enabled:
                await f.lab.ensure_history()
                try:
                    out = await asyncio.to_thread(f.brain.ask, REFLECT_SYSTEM, self._prompt(), self._schema(), 400)
                except LLMError as e:
                    await f.say("ava", "chatter", f"Reflection session failed: {e}")
                    out = self._fallback()
            else:
                out = self._fallback()
            await self._apply(out)
        except Exception as e:      # never let reflection crash the floor
            await f.say("ava", "chatter", f"Reflection accident: {e!r}"[:140])
        finally:
            self.reflecting = False
            f.save()
            await f.push()

    def _fallback(self):
        """No AI brain: plain reflections from the numbers, no pitches or requests."""
        people = []
        for aid in self._people():
            p = self.get(aid)
            n = p["wins"] + p["losses"]
            mood = "focused" if not n else "confident" if p["pnl"] > 0 else "uneasy"
            journal = f"{p['wins']} wins, {p['losses']} losses, ${p['pnl']:,.0f} realized so far." if n else "Still waiting for my first trade."
            people.append(dict(id=aid, journal=journal, lesson="", goal="", mood=mood))
        return dict(people=people, pitches=[], tool_request=dict(by="ava", what="", why=""), firm_lesson="")

    async def _apply(self, out):
        f = self.floor
        now = time.time()
        for r in out.get("people", []):
            aid = r.get("id")
            if aid not in self.m and aid not in f.names:
                continue
            p = self.get(aid)
            if r.get("journal"):
                p["journal"] = (p["journal"] + [dict(t=now, text=r["journal"][:300])])[-20:]
            if r.get("lesson"):
                p["lessons"] = (p["lessons"] + [dict(t=now, text=r["lesson"][:200])])[-12:]
                p["xp"] += 5
            if r.get("goal"):
                p["goal"] = r["goal"][:120]
            if r.get("mood") in MOODS:
                p["mood"] = r["mood"]
        if out.get("firm_lesson"):
            self.firm_lessons = (self.firm_lessons + [dict(t=now, text=out["firm_lesson"][:200], by="boss")])[-25:]
        # a couple of journal lines out loud, so you can hear the team think
        speak = [r for r in out.get("people", []) if r.get("journal")]
        for r in random.sample(speak, min(3, len(speak))):
            await f.say(r["id"], "journal", r["journal"][:220], pause=4)
        if out.get("firm_lesson"):
            await f.say("boss", "meeting", f"Lesson for the whole firm: {out['firm_lesson'][:200]}", pause=3)
        for pt in out.get("pitches", [])[:2]:
            rules = clean_rules(pt.get("rules"))
            item = dict(t=now, by=pt.get("by", "ava"), name=str(pt.get("name", "Untitled"))[:40], family="custom",
                        params=dict(rules=rules, direction=pt.get("direction", "long"), stop_atr=pt.get("stop_atr"),
                                    trail_atr=pt.get("trail_atr"), max_bars=pt.get("max_bars")),
                        markets=pt.get("markets") or [], hypothesis=str(pt.get("hypothesis", ""))[:200],
                        failure_mode=str(pt.get("failure_mode", ""))[:120])
            self.pitches = (self.pitches + [item])[-20:]
            self.get(item["by"])["pitched"] += 1
            await self.remember(item["by"], "pitch", f"Pitched '{item['name']}': {describe_rules(rules)[:110]}", xp=8)
            await f.say(item["by"], "pitch", f"I want to pitch something new: \"{item['name']}\". {item['hypothesis']}"[:230], pause=4)
        tr = out.get("tool_request") or {}
        what = str(tr.get("what", "")).strip()
        recent_req = [r for r in self.requests if now - r["t"] < 24 * 3600]
        if what and not recent_req and not any(what.lower() == r["what"].lower() for r in self.requests):
            by = tr.get("by", "ava")
            req = dict(t=now, by=by, what=what[:160], why=str(tr.get("why", ""))[:240], status="asked")
            self.requests.append(req)
            await self.remember(by, "request", f"Asked Jason for a new tool: {what[:100]}", xp=5)
            await f.board.post("fund", by, "jason", "tool_request",
                               f"{f.names.get(by, by)} asks for a new tool: {what}. Why: {req['why']}", data=dict(req=req))

    def snapshot(self):
        f = self.floor
        out = []
        for aid in self._people():
            p = self.get(aid)
            lvl, title, nxt = level_of(p["xp"])
            out.append(dict(id=aid, name=f.names.get(aid, aid), role=p["role"], traits=p["traits"], xp=p["xp"], level=lvl,
                            title=title, next_xp=nxt, mood=p["mood"], goal=p["goal"], journal=p["journal"][-3:],
                            lessons=p["lessons"][-4:], memories=p["memories"][-5:], wins=p["wins"], losses=p["losses"],
                            pnl=p["pnl"], passed=p["passed"], failed=p["failed"], pitched=p["pitched"]))
        tally = self.block_scoreboard(f.lab.log)
        return dict(people=out, firm_lessons=self.firm_lessons[-8:], pitches=self.pitches[-6:], requests=self.requests[-8:],
                    reflecting=self.reflecting, next_reflect=max(0, int(self.last_reflect + REFLECT_EVERY_H * 3600 - time.time())),
                    blocks={b: dict(passed=w, failed=l) for b, (w, l) in tally.items()}, kit=list(BLOCKS))
