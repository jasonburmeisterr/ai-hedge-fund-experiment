"""JB Ventures: the venture studio in the tower next to the fund.

Three AI agents run an idea pipeline, the same way the fund's lab runs strategies:
  Iris (scout)            - proposes business ideas, starting from the AI-startup landscape research
  Theo (market analyst)   - researches each idea ON THE WEB: customers, pain, competitors + their pricing, distribution
  Rosa (managing partner) - scores the idea on a fixed rubric; the score (not vibes) decides the verdict
Verdicts: GREENLIT (>= 70/100), WATCHLIST (55-69), KILLED (< 55).
Every researched idea gets a markdown report in claudeworkspace/venture-studio/reports/."""
import asyncio
import os
import re
import time

from . import config as C
from .llm import LLMError

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))       # claudeworkspace
REPORTS = os.path.join(ROOT, "venture-studio", "reports")
LANDSCAPE = os.path.join(ROOT, "ai-startup-research", "ANALYSIS.md")

FOUNDER = ("Founder: Jason, 18, first-year college student in Florida (finance/accounting track), learning Python, "
           "building AI tools with Claude Code (has a Claude Max plan). Interested in finance, trading and AI. "
           "Student budget (a few hundred dollars to start), part-time hours. Strengths: can ship software fast with AI, "
           "understands markets/finance, close to students and young people. He can't raise money yet or work full time.")

# Rosa's rubric: weights add up to 100. Each factor is scored 1-10.
RUBRIC = {
    "demand": (25, "people clearly have this problem and already pay (money or lots of time) to solve it"),
    "founder_fit": (20, "Jason can build and sell this himself, with his skills, budget and hours"),
    "speed_to_revenue": (15, "first paying customer within ~60 days is realistic"),
    "competition_gap": (15, "a real gap exists: incumbents are expensive, generic, or ignore this customer"),
    "defensibility": (15, "it can build an edge over time: data, niche community, workflow lock-in, brand"),
    "ai_leverage": (10, "AI makes it 10x cheaper/better than doing it the old way"),
}
GREEN, WATCH = 70, 55

SCOUT_SYSTEM = ("You are Iris, the idea scout at JB Ventures, a one-founder venture studio. You propose concrete, small, "
                "startable businesses (not moonshots) that the founder could launch with software + AI. You learn from the "
                "pipeline: never repeat an idea, explore new customers and industries when past ideas were killed, and go "
                "deeper on themes that were greenlit. Reply only with the JSON.")
ANALYST_SYSTEM = ("You are Theo, market analyst at JB Ventures. Research the idea on the web BEFORE answering: search for "
                  "the real competitors, their actual pricing, and evidence that customers have the pain (forums, reviews, "
                  "Reddit, job posts, surveys). Be specific and skeptical, cite URLs you actually read, never invent sources "
                  "or numbers; say 'unknown' when you couldn't verify something. Reply only with the JSON.")
PARTNER_SYSTEM = ("You are Rosa, managing partner at JB Ventures. You score ideas honestly against a fixed rubric using the "
                  "analyst's research. Most ideas should NOT be greenlit. Be blunt but constructive. Reply only with the JSON.")

S = {"type": "string"}
SCOUT_SCHEMA = {"type": "object", "properties": {
    "notes": {"type": "string", "description": "1-2 sentences: what you learned from the pipeline and where you're looking now"},
    "ideas": {"type": "array", "items": {"type": "object", "properties": {
        "name": {"type": "string", "description": "short product name, max 4 words"},
        "one_liner": {"type": "string", "description": "what it is, for whom, max 20 words"},
        "customer": {"type": "string", "description": "the specific first customer"},
        "problem": S, "why_now": S,
        "inspired_by": {"type": "string", "description": "a company from the landscape it borrows from, or 'original'"},
        "category": S}, "required": ["name", "one_liner", "customer", "problem", "why_now", "inspired_by", "category"],
        "additionalProperties": False}}},
    "required": ["notes", "ideas"], "additionalProperties": False}
RESEARCH_SCHEMA = {"type": "object", "properties": {
    "summary": {"type": "string", "description": "3-4 sentences: the honest picture"},
    "customer_segment": S,
    "pain_evidence": {"type": "array", "items": S, "description": "specific evidence of the pain, each with its source"},
    "competitors": {"type": "array", "items": {"type": "object", "properties": {
        "name": S, "pricing": S, "weakness": S, "url": S},
        "required": ["name", "pricing", "weakness", "url"], "additionalProperties": False}},
    "pricing_model": {"type": "string", "description": "what we'd charge and why"},
    "market_size": {"type": "string", "description": "rough bottom-up estimate with the math shown"},
    "first_customers": {"type": "string", "description": "exactly how to get the first 10 customers"},
    "build": {"type": "string", "description": "what the MVP is and roughly how long it takes to build with AI tools"},
    "risks": {"type": "array", "items": S},
    "sources": {"type": "array", "items": S, "description": "URLs actually read"}},
    "required": ["summary", "customer_segment", "pain_evidence", "competitors", "pricing_model", "market_size",
                 "first_customers", "build", "risks", "sources"], "additionalProperties": False}
SCORE_SCHEMA = {"type": "object", "properties": {
    "scores": {"type": "object", "properties": {k: {"type": "integer", "minimum": 1, "maximum": 10} for k in RUBRIC},
               "required": list(RUBRIC), "additionalProperties": False},
    "memo": {"type": "string", "description": "3 sentences: the decision and the single biggest reason"},
    "biggest_risk": S,
    "next_steps": {"type": "array", "items": S, "description": "3 concrete first steps for this week (if it went ahead)"}},
    "required": ["scores", "memo", "biggest_risk", "next_steps"], "additionalProperties": False}


def total(scores):
    return round(sum(w * scores.get(k, 0) / 10 for k, (w, _) in RUBRIC.items()))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "idea"


class Studio:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.pipeline: list = st.get("pipeline", [])
        self.status = "idle"
        self.current = None
        self.running = False
        self.next_at = time.time() + C.STUDIO_FIRST_SEC

    def to_state(self):
        return dict(pipeline=self.pipeline[-120:])

    def item(self, iid):
        return next((x for x in self.pipeline if x["id"] == iid), None)

    def snapshot(self):
        light = [{k: x.get(k) for k in ("id", "name", "one_liner", "customer", "category", "stage", "total", "verdict", "t", "scores", "memo")}
                 for x in self.pipeline[-40:]]
        counts = {v: sum(1 for x in self.pipeline if x.get("verdict") == v) for v in ("GREENLIT", "WATCHLIST", "KILLED")}
        return dict(status=self.status, current=self.current, next_in=max(0, int(self.next_at - time.time())),
                    pipeline=light, counts=counts, on=self.floor.brain.enabled)

    async def maybe_run(self, force=False):
        f = self.floor
        if self.running or not f.brain.enabled or (not force and (time.time() < self.next_at or f.lab.running)):
            return
        self.next_at = time.time() + C.STUDIO_EVERY_MIN * 60
        self.running = True
        asyncio.create_task(self._wrap())

    async def _wrap(self):
        try:
            await self._session()
        except Exception as e:
            await self.floor.say("rosa", "chatter", f"Studio hiccup: {e!r}"[:140])
        finally:
            self.status, self.current, self.running = "idle", None, False
            self.floor.save()
            await self.floor.push()

    def _brief(self):
        try:
            landscape = open(LANDSCAPE, encoding="utf-8").read()
        except OSError:
            landscape = "(landscape research not found)"
        past = [f"- [{x.get('verdict') or x['stage']}] {x['name']} ({x.get('category', '')}): {x['one_liner']}"
                + (f" -> {x.get('total')}/100. {x.get('memo', '')[:160]}" if x.get("total") is not None else "")
                for x in self.pipeline[-30:]]
        b = self.floor.board
        reqs = b.inbox("studio", "request")
        briefs = [p["text"] for p in b.posts if p["to"] == "studio" and p["topic"] == "market_brief"][-2:]
        trends = [p["text"] for p in b.posts if p["to"] == "studio" and p["topic"] == "trends"][-2:]
        wire = ""
        if reqs:
            wire += ("\n\n## Founder requests on the Wire (Jason asked for these: at least one of your ideas MUST answer them)\n"
                     + "\n".join(f"- {p['text']}" for p in reqs))
        if briefs:
            wire += "\n\n## Latest notes from JB Capital (the fund next door)\n" + "\n".join(f"- {t}" for t in briefs)
        if trends:
            wire += "\n\n## AI/startup trends from JB Newsroom (real headlines this week)\n" + "\n".join(f"- {t}" for t in trends)
        reading = self.floor.library.lessons_for({"iris", "theo", "rosa"})
        if reading:
            wire += "\n\n## What the studio team learned in the Study Hall library (apply it)\n" + "\n".join(
                f"- {n['name']} read {n['topic']}: {n['lesson']}" for n in reading)
        return (f"{FOUNDER}\n\n## AI-startup landscape research (for inspiration)\n{landscape}{wire}\n\n"
                f"## Pipeline so far\n" + ("\n".join(past) or "- empty: this is the first session") +
                f"\n\n## How ideas are judged\n" + "\n".join(f"- {k} ({w} pts): {d}" for k, (w, d) in RUBRIC.items()) +
                f"\nGREENLIT >= {GREEN}, WATCHLIST >= {WATCH}, otherwise KILLED.\n\n"
                f"Propose exactly {C.STUDIO_IDEAS} NEW ideas, different from everything in the pipeline.")

    async def _session(self):
        f = self.floor
        self.status = "scouting"
        await f.say("rosa", "studio", "Studio meeting. Iris, what have you found?", pause=3, phase="start")
        try:
            out = await asyncio.to_thread(f.brain.ask, SCOUT_SYSTEM, self._brief(), SCOUT_SCHEMA)
        except LLMError as e:
            await f.say("iris", "chatter", f"Scouting failed: {e}")
            return
        if out.get("notes"):
            await f.say("iris", "studio", out["notes"][:220], pause=4, phase="scout")
        reqs = f.board.inbox("studio", "request")
        for p in f.board.inbox("studio", "market_brief") + f.board.inbox("studio", "trends"):
            f.board.ack(p, "iris")
        for p in reqs:                      # take the requests off the board so the next meeting doesn't repeat them
            p["status"] = "working"
        done = []
        for idea in out.get("ideas", [])[:C.STUDIO_IDEAS]:
            x = await self._evaluate(idea)
            if x:
                done.append(f"{x['name']} ({x.get('verdict') or x['stage']}" + (f", {x['total']}/100)" if x.get("total") is not None else ")"))
        for p in reqs:
            await f.board.reply(p, "rosa", ("We took your request into today's meeting. Ideas: " + "; ".join(done) + ". Full reports in the Ventures tab.")
                                if done else "We looked at your request, but the research failed this round. We'll retry next meeting.")

    async def _evaluate(self, idea):
        f = self.floor
        x = dict(id=f"v{time.time_ns()}", t=time.time(), stage="researching", **{k: str(idea.get(k, ""))[:300] for k in
                 ("name", "one_liner", "customer", "problem", "why_now", "inspired_by", "category")})
        x["name"] = x["name"][:40] or "Untitled"
        self.pipeline.append(x)
        self.current = {k: x[k] for k in ("id", "name", "one_liner", "customer")}
        self.status = "researching"
        await f.say("iris", "studio", f'New idea: "{x["name"]}". {x["one_liner"]}'[:230], pause=4, phase="idea", idea=self.current)
        await f.say("theo", "studio", f'On it. Researching {x["name"]}: competitors, pricing, real customer pain...', pause=2, phase="research")
        await f.push()
        prompt = (f"{FOUNDER}\n\nIdea: {x['name']}: {x['one_liner']}\nCustomer: {x['customer']}\nProblem: {x['problem']}\n"
                  f"Why now: {x['why_now']}\nInspired by: {x['inspired_by']}\n\nResearch it on the web, then answer.")
        try:
            res = await asyncio.to_thread(f.brain.ask, ANALYST_SYSTEM, prompt, RESEARCH_SCHEMA, 600, True)
        except LLMError as e:
            x["stage"] = "failed"
            await f.say("theo", "chatter", f"Research on {x['name']} failed: {e}")
            return x
        x["research"] = res
        x["stage"] = "scoring"
        self.status = "scoring"
        comp = ", ".join(c["name"] for c in res.get("competitors", [])[:4]) or "none found"
        await f.say("theo", "studio", f"{x['name']}: {res.get('summary', '')[:150]} Competitors: {comp}."[:260], pause=4, phase="report")
        await f.say("rosa", "studio", f"Let me score {x['name']}.", pause=2, phase="score")
        import json
        try:
            sc = await asyncio.to_thread(f.brain.ask, PARTNER_SYSTEM,
                                         f"{FOUNDER}\n\n## Rubric\n" + "\n".join(f"- {k} ({w} pts): {d}" for k, (w, d) in RUBRIC.items()) +
                                         f"\n\n## Idea\n{json.dumps({k: x[k] for k in ('name', 'one_liner', 'customer', 'problem', 'why_now')})}"
                                         f"\n\n## Analyst research\n{json.dumps(res)}", SCORE_SCHEMA)
        except LLMError as e:
            x["stage"] = "failed"
            await f.say("rosa", "chatter", f"Couldn't score {x['name']}: {e}")
            return x
        x["scores"] = {k: max(1, min(10, int(sc["scores"].get(k, 1)))) for k in RUBRIC}
        x["total"] = total(x["scores"])
        x["verdict"] = "GREENLIT" if x["total"] >= GREEN else "WATCHLIST" if x["total"] >= WATCH else "KILLED"
        x.update(memo=sc.get("memo", ""), biggest_risk=sc.get("biggest_risk", ""), next_steps=sc.get("next_steps", [])[:5], stage="decided")
        x["report"] = self._write_report(x)
        self.status = "verdict"
        await f.say("rosa", "studio", f"{x['verdict']}: {x['name']} scores {x['total']}/100. {x['memo']}"[:260], pause=4,
                    phase="verdict", ok=x["verdict"] != "KILLED", verdict=x["verdict"], title=x["name"])
        if x["verdict"] == "GREENLIT":
            await f.board.post("studio", "rosa", "fund", "greenlit", f"FYI: we greenlit {x['name']} ({x['total']}/100). {x['one_liner']}",
                               data=dict(idea=x["id"]))
            await f.board.post("studio", "rosa", "jason", "greenlit", f"Greenlit: {x['name']} ({x['total']}/100). Report: {x.get('report') or 'Ventures tab'}",
                               data=dict(idea=x["id"]))
        f.save()
        await f.push()
        return x

    def _write_report(self, x):
        try:
            os.makedirs(REPORTS, exist_ok=True)
            r = x.get("research", {})
            path = os.path.join(REPORTS, f"{time.strftime('%Y-%m-%d')}-{slug(x['name'])}.md")
            lines = [f"# {x['name']}  ({x['verdict']}, {x['total']}/100)", "", f"> {x['one_liner']}", "",
                     f"**Customer:** {x['customer']}  ", f"**Problem:** {x['problem']}  ", f"**Why now:** {x['why_now']}  ",
                     f"**Inspired by:** {x['inspired_by']} · **Category:** {x['category']}", "",
                     "## Rosa's decision", x.get("memo", ""), "", f"**Biggest risk:** {x.get('biggest_risk', '')}", "",
                     "| Factor | Weight | Score |", "|---|---|---|"]
            lines += [f"| {k.replace('_', ' ')} | {w} | {x['scores'][k]}/10 |" for k, (w, _) in RUBRIC.items()]
            lines += ["", "## Next steps (if we go ahead)"] + [f"{i + 1}. {s}" for i, s in enumerate(x.get("next_steps", []))]
            lines += ["", "## Theo's research", r.get("summary", ""), "", f"**Customer segment:** {r.get('customer_segment', '')}", "",
                      "### Evidence of the pain"] + [f"- {e}" for e in r.get("pain_evidence", [])]
            lines += ["", "### Competitors", "| Name | Pricing | Weakness |", "|---|---|---|"]
            lines += [f"| [{c['name']}]({c['url']}) | {c['pricing']} | {c['weakness']} |" for c in r.get("competitors", [])]
            lines += ["", f"**Pricing model:** {r.get('pricing_model', '')}", "", f"**Market size:** {r.get('market_size', '')}", "",
                      f"**First 10 customers:** {r.get('first_customers', '')}", "", f"**Build:** {r.get('build', '')}", "",
                      "### Risks"] + [f"- {e}" for e in r.get("risks", [])]
            lines += ["", "### Sources"] + [f"- {u}" for u in r.get("sources", [])]
            lines += ["", f"_JB Ventures · {time.strftime('%Y-%m-%d %H:%M')} · AI-generated research: verify before acting._"]
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines))
            return os.path.relpath(path, ROOT).replace("\\", "/")
        except OSError:
            return None
