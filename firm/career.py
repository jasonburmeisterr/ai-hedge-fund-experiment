"""JB Careers: the fourth tower. It works Jason's real career pipeline.

  Cole (career director)   - daily standup: follow-ups due, career deadlines, Zetamac trend; answers Jason on the Wire
  Maya (opportunity scout) - researches internships / early programs on the web (when the AI brain is on)
  Drew (outreach coach)    - drafts follow-up messages and career-fair prep. DRAFTS ONLY: Jason sends everything himself.

The source of truth is Jason's JB Terminal file (contacts, events, Zetamac scores). This tower only READS it.
Personal notes are never sent to the AI, reports go to career_reports/ (gitignored), nothing is ever sent to anyone."""
import asyncio
import datetime as dt
import json
import os
import re
import time

from . import config as C
from .llm import LLMError

TERMINAL = os.environ.get("FLOOR_TERMINAL") or os.path.join(os.path.expanduser("~"), "Documents", "JBTerminal", "data.json")
REPORTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "career_reports")
CAREER_RX = re.compile(r"career|fair|intern|program|deadline|application|apply|interview|recruit|linkedin|follow.?up|"
                       r"jane street|citadel|hrt|hudson river|imc|sig\b|susquehanna|optiver|five rings|d\.?e\.? shaw|"
                       r"worldquant|prosperity|focus|fttp|insight|networking|coffee chat|call with", re.I)
FIRMS = ["Jane Street", "Citadel", "IMC", "Susquehanna", "SIG", "Optiver", "Hudson River Trading", "Two Sigma", "D.E. Shaw",
         "Five Rings", "WorldQuant", "Jump Trading", "DRW", "Akuna", "Virtu", "Bank of America", "Goldman Sachs", "JPMorgan"]
DONE_STATUSES = {"Keeping in touch"}

S = {"type": "string"}
DRAFT_SCHEMA = {"type": "object", "properties": {
    "message": {"type": "string", "description": "the follow-up message, under 70 words, warm and specific, no dashes"},
    "why": {"type": "string", "description": "one line: why this angle"}}, "required": ["message", "why"], "additionalProperties": False}
DRAFT_SYSTEM = ("You are Drew, outreach coach at JB Careers. Jason is an 18-year-old first-year finance student at FSW in Florida "
                "who wants to break into quant/prop trading; he has social anxiety and likes short, natural messages. Draft ONE "
                "follow-up message he can copy and send himself. Be warm, specific to what's known, never pushy, never ask for a "
                "job directly, no dashes. Reply only with the JSON.")
PREP_SCHEMA = {"type": "object", "properties": {
    "pitch": {"type": "string", "description": "a 30-second intro Jason can say out loud, first person, natural"},
    "targets": {"type": "array", "items": {"type": "object", "properties": {
        "org": S, "what_they_do": {"type": "string", "description": "one sentence"},
        "questions": {"type": "array", "items": S, "description": "2 smart questions to ask at the booth"},
        "angle": {"type": "string", "description": "how Jason's background connects, one sentence"}},
        "required": ["org", "what_they_do", "questions", "angle"], "additionalProperties": False}},
    "checklist": {"type": "array", "items": S, "description": "5 short day-of steps"}},
    "required": ["pitch", "targets", "checklist"], "additionalProperties": False}
PREP_SYSTEM = ("You are Drew, career coach at JB Careers. Build a career-fair prep sheet for Jason (18, first-year at FSW, "
               "finance/accounting track, president of the algorithmic trading club, builds AI tools and a paper-trading AI hedge "
               "fund simulator, aiming for quant/prop trading, transferring to a university ~2028, graduating ~2030). He has social "
               "anxiety: make it concrete, short and calming. Reply only with the JSON.")
SCOUT_SCHEMA = {"type": "object", "properties": {
    "notes": {"type": "string", "description": "1-2 sentences on what you found"},
    "opportunities": {"type": "array", "items": {"type": "object", "properties": {
        "name": S, "org": S, "deadline": {"type": "string", "description": "YYYY-MM-DD, or 'rolling' / 'unknown'"},
        "eligible": {"type": "string", "description": "why a first-year community-college student graduating ~2030 qualifies, or the catch"},
        "url": S}, "required": ["name", "org", "deadline", "eligible", "url"], "additionalProperties": False}}},
    "required": ["notes", "opportunities"], "additionalProperties": False}
SCOUT_SYSTEM = ("You are Maya, opportunity scout at JB Careers. Search the web for CURRENT early-career programs, insight weeks, "
                "competitions and internships that a first-year US college student (community college in Florida, finance focus, "
                "graduating ~2030) can apply to, in quant/prop trading, hedge funds, banking or fintech. Prefer official pages, "
                "give real deadlines, never invent programs or dates; say 'unknown' when unsure. Skip anything already in his list. "
                "Reply only with the JSON.")
ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "description": "max 110 words, plain text"}},
                 "required": ["answer"], "additionalProperties": False}
ANSWER_SYSTEM = ("You are Cole, career director at JB Careers. Jason asked a question. Answer briefly and concretely using his "
                 "pipeline below. Be encouraging without fluff; small next steps beat big plans. Reply only with the JSON.")


def day(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


class Career:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.opps: list = st.get("opps", [])
        self.drafts: dict = st.get("drafts", {})            # contact id -> {message, why, t, due}
        self.prep: dict | None = st.get("prep")
        self.firm_news: list = st.get("firm_news", [])
        self.last_standup = st.get("last_standup", "")
        self.last_scout = st.get("last_scout", 0.0)
        self.data: dict = {}
        self.mtime = 0.0
        self.error = None
        self.status = "idle"
        self.busy = False
        self.answering = False
        self.load()

    def to_state(self):
        return dict(opps=self.opps[-60:], drafts=self.drafts, prep=self.prep, firm_news=self.firm_news[-30:],
                    last_standup=self.last_standup, last_scout=self.last_scout)

    # ── reading JB Terminal (read-only) ──
    def load(self):
        try:
            m = os.path.getmtime(TERMINAL)
            if m != self.mtime:
                with open(TERMINAL, encoding="utf-8") as f:
                    self.data = json.load(f)
                self.mtime = m
            self.error = None
        except (OSError, ValueError) as e:
            self.error = f"Can't read JB Terminal data: {type(e).__name__}"

    def digest(self):
        today = dt.date.today()
        contacts = self.data.get("Contacts", [])
        due = []
        for c in contacts:
            d = day(c.get("NextFollowUp"))
            if d and d <= today + dt.timedelta(days=1) and c.get("Status") not in DONE_STATUSES:
                due.append(dict(id=c["Id"], name=c.get("Name", ""), org=c.get("Org", ""), role=c.get("Role", ""),
                                status=c.get("Status", ""), due=str(d), overdue=(today - d).days))
        due.sort(key=lambda x: x["due"])
        events = []
        for e in self.data.get("Events", []):
            d = day(e.get("Date"))
            if d and today <= d <= today + dt.timedelta(days=120) and CAREER_RX.search(e.get("Title", "")):
                events.append(dict(title=e["Title"], date=str(d), days=(d - today).days))
        events.sort(key=lambda x: x["date"])
        seen = set()                                          # repeating events (club meetings): keep the next one only
        events = [e for e in events if not (e["title"] in seen or seen.add(e["title"]))][:10]
        scores = sorted((s for s in self.data.get("Scores", []) if s.get("Mode") == "Zetamac"),        # the full mixed-operations game
                        key=lambda s: s.get("Created", s.get("Date", "")))
        vals = [s["Score"] for s in scores]
        z = dict(last=vals[-1] if vals else None, best=max(vals) if vals else None, n=len(vals),
                 avg5=round(sum(vals[-5:]) / len(vals[-5:]), 1) if vals else None)
        counts = {}
        for c in contacts:
            counts[c.get("Status", "?")] = counts.get(c.get("Status", "?"), 0) + 1
        ladder = self.data.get("Ladder", [])
        return dict(due=due, events=events, zetamac=z, pipeline=counts, contacts=len(contacts),
                    ladder=dict(done=sum(1 for l in ladder if l.get("Done")), total=len(ladder)))

    def snapshot(self):
        g = self.digest()
        g.update(status=self.status, error=self.error, opps=self.opps[-20:], prep=self.prep, firm_news=self.firm_news[-10:],
                 drafts={k: v for k, v in self.drafts.items() if any(d["id"] == k for d in g["due"])},
                 next_scout_in=max(0, int(self.last_scout + C.CAREER_SCOUT_H * 3600 - time.time())), on=self.floor.brain.enabled)
        return g

    def watch_firms(self):
        orgs = {c.get("Org", "").strip() for c in self.data.get("Contacts", []) if len(c.get("Org", "").strip()) > 2}
        return sorted(set(FIRMS) | orgs)

    # ── the loop ──
    async def step(self):
        f = self.floor
        self.load()
        if self.busy:
            return
        g = self.digest()
        today = str(dt.date.today())
        if self.last_standup != today and dt.datetime.now().hour >= 7:
            self.last_standup = today
            await self.standup(g)
        if not f.brain.enabled:
            return
        fair = next((e for e in g["events"] if re.search(r"career fair", e["title"], re.I) and e["days"] <= 7), None)
        job = None
        if fair and (not self.prep or self.prep.get("event") != f"{fair['title']}|{fair['date']}"):
            job = self.fair_prep(fair)
        elif (todo := [d for d in g["due"] if d["id"] not in self.drafts or self.drafts[d["id"]].get("due") != d["due"]]):
            job = self.draft(todo[0])
        elif time.time() - self.last_scout > C.CAREER_SCOUT_H * 3600 and not f.lab.running:
            job = self.scout()
        if job:
            self.busy = True
            asyncio.create_task(self._wrap(job))
        if f.board.inbox("career") and not self.answering:
            asyncio.create_task(self.answer_inbox())

    async def _wrap(self, job):
        try:
            await job
        except Exception as e:
            await self.floor.say("cole", "chatter", f"Career desk hiccup: {e!r}"[:140])
        finally:
            self.busy = False
            self.status = "idle"
            self.floor.save()
            await self.floor.push()

    async def standup(self, g):
        f = self.floor
        parts = []
        if g["due"]:
            parts.append(f"{len(g['due'])} follow-up{'s' if len(g['due']) > 1 else ''} due: " + ", ".join(d["name"].split()[0] for d in g["due"][:5]))
        nxt = [e for e in g["events"] if e["days"] <= 14][:2]
        if nxt:
            when = lambda e: "TODAY" if e["days"] == 0 else "tomorrow" if e["days"] == 1 else "in %d days" % e["days"]
            parts.append("; ".join(e["title"] + " " + when(e) for e in nxt))
        z = g["zetamac"]
        if z["last"] is not None:
            parts.append(f"Zetamac last {z['last']}, best {z['best']}")
        text = ". ".join(parts) or "Nothing due today. Good day to send one new connection request."
        await f.say("cole", "career", f"Morning standup: {text}.", phase="standup")
        await f.board.post("career", "cole", "jason", "standup", f"Career standup: {text}.")

    async def draft(self, d):
        f = self.floor
        self.status = "drafting"
        c = next((x for x in self.data.get("Contacts", []) if x["Id"] == d["id"]), {})
        await f.say("drew", "career", f"Drafting a follow-up for {d['name']} ({d['org']}).", phase="draft")
        prompt = (f"Contact: {c.get('Name')} — {c.get('Role')} at {c.get('Org')} ({c.get('Category')}).\n"
                  f"Status: {c.get('Status')}. Follow-up due {d['due']}.\nWhat we know: {str(c.get('Notes', ''))[:600]}")
        try:
            res = await asyncio.to_thread(f.brain.ask, DRAFT_SYSTEM, prompt, DRAFT_SCHEMA)
        except LLMError as e:
            await f.say("drew", "chatter", f"Couldn't draft that one: {e}")
            self.drafts[d["id"]] = dict(message="", why=f"draft failed: {e}"[:120], t=time.time(), due=d["due"])
            return
        self.drafts[d["id"]] = dict(message=res.get("message", "")[:700], why=res.get("why", "")[:200], t=time.time(), due=d["due"])
        await f.say("drew", "career", f"Draft ready for {d['name']}. It's in the Career tab: copy it and send it yourself.", phase="ready")

    async def fair_prep(self, fair):
        f = self.floor
        self.status = "prepping"
        fd = fair["date"]
        targets = [c for c in self.data.get("Contacts", []) if str(c.get("NextFollowUp", ""))[:10] == fd]
        await f.say("drew", "career", f"{fair['title']} in {fair['days']} days. Building your prep sheet: pitch, booth questions, checklist.", phase="prep")
        await f.board.post("career", "drew", "fund", "request_fact", "Quick one for Jason's career-fair pitch: what's the fund's honest track record so far?")
        prompt = (f"Event: {fair['title']} on {fd}.\nTargets:\n" + ("\n".join(f"- {c.get('Org')} ({c.get('Role') or c.get('Category')})" for c in targets)
                  or "- (no specific booths listed: suggest how to pick 5)") + f"\n\nHis AI fund simulator right now: {f.status_text()}")
        try:
            res = await asyncio.to_thread(f.brain.ask, PREP_SYSTEM, prompt, PREP_SCHEMA)
        except LLMError as e:
            await f.say("drew", "chatter", f"Prep sheet failed: {e}")
            return
        self.prep = dict(event=f"{fair['title']}|{fd}", title=fair["title"], date=fd, t=time.time(), **res)
        self._report(f"{fd}-career-fair-prep.md", self._prep_md())
        await f.say("drew", "career", "Prep sheet ready: 30-second pitch, 2 questions per booth, day-of checklist.", phase="ready")
        await f.board.post("career", "drew", "jason", "prep", f"Your {fair['title']} prep sheet is ready (Career tab). Practice the pitch out loud twice.")

    async def scout(self):
        f = self.floor
        self.status = "scouting"
        self.last_scout = time.time()
        known = [e["title"] for e in self.digest()["events"]] + [o["name"] for o in self.opps]
        await f.say("maya", "career", "Scouting early programs and internships on the web…", phase="scout")
        try:
            res = await asyncio.to_thread(f.brain.ask, SCOUT_SYSTEM, f"Already on his list: {', '.join(known) or 'nothing'}\n"
                                          f"Today: {dt.date.today()}. Find up to 6 new ones.", SCOUT_SCHEMA, 600, True)
        except LLMError as e:
            await f.say("maya", "chatter", f"Scouting failed: {e}")
            return
        names = {o["name"].lower() for o in self.opps}
        new = [dict(o, t=time.time()) for o in res.get("opportunities", []) if o.get("name", "").lower() not in names][:6]
        self.opps += new
        self._report(f"{dt.date.today()}-opportunities.md", "\n".join([f"# New opportunities ({dt.date.today()})", "", res.get("notes", ""), ""] +
                     [f"- **{o['name']}** ({o['org']}): deadline {o['deadline']}. {o['eligible']} {o['url']}" for o in new]))
        await f.say("maya", "career", f"Found {len(new)} new opportunit{'y' if len(new) == 1 else 'ies'}. {res.get('notes', '')}"[:240], phase="found")
        soon = [o for o in new if day(o["deadline"]) and (day(o["deadline"]) - dt.date.today()).days <= 45]
        if soon:
            await f.board.post("career", "maya", "jason", "opportunity",
                               "Deadline soon: " + "; ".join(f"{o['name']} ({o['deadline']})" for o in soon[:3]) + ". Check them in the Career tab.")

    def note_firm_news(self, items):
        """The newsroom spotted headlines about firms Jason cares about."""
        seen = {x["title"] for x in self.firm_news}
        add = [dict(title=x["title"], source=x["source"], link=x["link"], firm=x["firm"], t=x["t"]) for x in items if x["title"] not in seen]
        self.firm_news = (self.firm_news + add)[-30:]
        return add

    def _prep_md(self):
        p = self.prep
        lines = [f"# {p['title']} prep ({p['date']})", "", "## 30-second pitch", p["pitch"], "", "## Booths"]
        for t in p["targets"]:
            lines += [f"### {t['org']}", t["what_they_do"], f"*Your angle:* {t['angle']}"] + [f"- {q}" for q in t["questions"]] + [""]
        return "\n".join(lines + ["## Day-of checklist"] + [f"- [ ] {c}" for c in p["checklist"]])

    def _report(self, name, text):
        try:
            os.makedirs(REPORTS, exist_ok=True)
            with open(os.path.join(REPORTS, name), "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError:
            pass

    # ── questions on the Wire ──
    async def answer_inbox(self):
        f = self.floor
        self.answering = True
        try:
            for p in f.board.inbox("career"):
                if p["topic"] != "request":
                    f.board.ack(p, "cole")
                    continue
                g = self.digest()
                due = ", ".join("%s (%s, %s, due %s)" % (d["name"], d["org"], d["status"], d["due"]) for d in g["due"]) or "none"
                evs = ", ".join("%s %s" % (e["title"], e["date"]) for e in g["events"]) or "none"
                opps = ", ".join("%s (%s)" % (o["name"], o["deadline"]) for o in self.opps[-8:]) or "none"
                ctx = (f"Follow-ups due: {due}\nCareer events: {evs}\nPipeline: {g['pipeline']}\n"
                       f"Zetamac: {g['zetamac']}\nOpportunities found: {opps}")
                ans = None
                if f.brain.enabled:
                    try:
                        ans = (await asyncio.to_thread(f.brain.ask, ANSWER_SYSTEM, f"{ctx}\n\nJason asks: {p['text']}", ANSWER_SCHEMA)).get("answer")
                    except LLMError:
                        pass
                await f.board.reply(p, "cole", ans or ("Here's your pipeline. " + ctx.replace("\n", " · "))[:1400])
            f.save()
            await f.push()
        finally:
            self.answering = False
