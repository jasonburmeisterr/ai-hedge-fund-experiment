"""JB Study Hall: the fifth tower. It helps Jason study in small, low-pressure steps.

  Sage (study planner) - reads his classes + Canvas tasks (JB Terminal, read-only) and posts a short daily plan:
                         three small blocks, quick win first, never a guilt trip
  Quinn (quiz master)  - makes 5-question practice rounds for what's coming up (AI brain), grades them on the spot,
                         and keeps a spaced-repetition deck: missed questions come back the next day
  Remy (tutor)         - answers questions on the Wire ("explain closing entries like I'm new to it")

Extensions (a due date that moved) are stored here, never written back to JB Terminal."""
import asyncio
import datetime as dt
import hashlib
import json
import os
import random
import re
import time

from . import config as C
from .career import TERMINAL, day
from .llm import LLMError

SKIP_COURSES = {"Personal", "Network"}            # career tasks live in the Career Tower
TEST_RX = re.compile(r"quiz|exam|test|assessment|midterm|final", re.I)

S = {"type": "string"}
QUIZ_SCHEMA = {"type": "object", "properties": {
    "topic": {"type": "string", "description": "short title for this practice round"},
    "questions": {"type": "array", "items": {"type": "object", "properties": {
        "q": {"type": "string", "description": "the question, one or two sentences"},
        "choices": {"type": "array", "items": S, "description": "exactly 4 answer choices, no letters in front"},
        "answer": {"type": "integer", "description": "index 0-3 of the correct choice"},
        "explain": {"type": "string", "description": "why it's right, max 35 words, plain and friendly"}},
        "required": ["q", "choices", "answer", "explain"], "additionalProperties": False}}},
    "required": ["topic", "questions"], "additionalProperties": False}
QUIZ_SYSTEM = ("You are Quinn, quiz master at JB Study Hall. Jason is a first-year college student (FSW, Florida) who is "
               "neurodivergent with test anxiety: make questions clear, concrete and fair, mixing easy and medium, like the "
               "intro-level textbook chapter they're about. Exactly 5 multiple-choice questions, 4 choices each, one correct, "
               "plausible distractors, no trick wording, no 'all of the above'. Reply only with the JSON.")
TUTOR_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "description": "max 150 words, plain text, one small example"}},
                "required": ["answer"], "additionalProperties": False}
TUTOR_SYSTEM = ("You are Remy, tutor at JB Study Hall. Jason (first-year college, finance/accounting track, neurodivergent, "
                "anxious about retaining info) asked a question. Explain simply, with one concrete example and a 1-line memory "
                "hook. Encouraging, never condescending. Reply only with the JSON.")


class StudyHall:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.ext: dict = st.get("ext", {})              # task id -> new due date (YYYY-MM-DD)
        self.quiz: dict | None = st.get("quiz")         # current round {id, topic, course, questions[], answers{}, t, review}
        self.deck: list = st.get("deck", [])            # spaced repetition cards
        self.log: list = st.get("log", [])              # {t, course, ok}
        self.last_plan = st.get("last_plan", "")
        self.plan: list = st.get("plan", [])
        self.data: dict = {}
        self.mtime = 0.0
        self.error = None
        self.busy = False
        self.answering = False
        self.load()

    def to_state(self):
        return dict(ext=self.ext, quiz=self.quiz, deck=self.deck[-400:], log=self.log[-2000:], last_plan=self.last_plan, plan=self.plan)

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

    # ── what's coming up ──
    def tasks(self):
        today = dt.date.today()
        out = []
        for t in self.data.get("Tasks", []):
            if t.get("Done") or t.get("Course") in SKIP_COURSES:
                continue
            d = day(self.ext.get(t["Id"]) or t.get("Due"))
            if not d:
                continue
            out.append(dict(id=t["Id"], title=t["Title"], course=t.get("Course", ""), due=str(d), days=(d - today).days,
                            test=bool(TEST_RX.search(t["Title"])), extended=t["Id"] in self.ext))
        return sorted(out, key=lambda x: (x["due"], not x["test"]))

    def classes_today(self):
        dow = (dt.date.today().weekday() + 1) % 7               # JB Terminal uses Sunday = 0
        return [dict(name=c.get("Name") or c.get("Course"), time=str(c.get("StartTime") or c.get("Start") or "")[:5], room=c.get("Room", ""))
                for c in self.data.get("Classes", []) if c.get("Day") == dow and not c.get("Online")]

    def make_plan(self):
        """Three small blocks: a quick win first, then the most urgent test prep, then the next due item."""
        ts = [t for t in self.tasks() if t["days"] >= -3]
        if not ts:
            return []
        soon = [t for t in ts if t["days"] <= 7]
        test = next((t for t in soon if t["test"]), None)
        quick = min((t for t in soon if not t["test"]), key=lambda t: (t["days"] < 0, len(t["title"]), t["days"]), default=None)   # never a test
        nxt = next((t for t in soon if t is not test and t is not quick), None)
        plan = []
        if quick:
            plan.append(dict(mins=10, kind="quick win", task=quick))
        if test:
            plan.append(dict(mins=20, kind="practice quiz", task=test))
        if nxt:
            plan.append(dict(mins=25, kind="do", task=nxt))
        return plan

    def stats(self):
        days = sorted({time.strftime("%Y-%m-%d", time.localtime(x["t"])) for x in self.log}, reverse=True)
        streak, d = 0, dt.date.today()
        for s in days:
            if s == str(d) or (streak == 0 and s == str(d - dt.timedelta(days=1))):
                streak += 1
                d = dt.date.fromisoformat(s) - dt.timedelta(days=1)
            elif s < str(d):
                break
        by = {}
        for x in self.log[-300:]:
            a = by.setdefault(x["course"] or "Other", [0, 0])
            a[0] += x["ok"]
            a[1] += 1
        return dict(answered=len(self.log), streak=streak, by_course={k: dict(ok=v[0], n=v[1]) for k, v in by.items()},
                    review_due=sum(1 for c in self.deck if c["due"] <= time.time()), deck=len(self.deck))

    def snapshot(self):
        q = None
        if self.quiz:
            q = dict(id=self.quiz["id"], topic=self.quiz["topic"], course=self.quiz["course"], review=self.quiz.get("review", False),
                     questions=[dict(q=x["q"], choices=x["choices"], **({"answer": x["answer"], "explain": x["explain"], "picked": self.quiz["answers"][str(i)]}
                                                                         if str(i) in self.quiz["answers"] else {}))
                                for i, x in enumerate(self.quiz["questions"])])
        return dict(tasks=self.tasks()[:24], today=self.classes_today(), plan=self.plan, quiz=q, stats=self.stats(),
                    busy=self.busy, on=self.floor.brain.enabled, error=self.error)

    # ── the loop ──
    async def step(self):
        self.load()
        today = str(dt.date.today())
        if self.last_plan != today and dt.datetime.now().hour >= 8:
            self.last_plan = today
            self.plan = self.make_plan()
            if self.plan:
                txt = " · ".join(f"{p['mins']} min {p['kind']}: {p['task']['course']} {p['task']['title'][:40]}" for p in self.plan)
                await self.floor.say("sage", "study", f"Today's plan, small steps: {txt}", phase="plan")
                await self.floor.board.post("study", "sage", "jason", "plan", f"Study plan ({sum(p['mins'] for p in self.plan)} min total): {txt}. One block at a time.")
        if self.floor.board.inbox("study") and not self.answering:
            asyncio.create_task(self.answer_inbox())

    # ── Quinn's practice rounds ──
    async def new_round(self, topic=None):
        if self.busy:
            return
        due = [c for c in self.deck if c["due"] <= time.time()]
        if not topic and len(due) >= 3:                      # review comes first: it's what makes things stick
            cards = random.sample(due, min(5, len(due)))
            self.quiz = dict(id=f"q{time.time_ns()}", topic="Review: questions you missed before", course=cards[0]["course"],
                             questions=[{k: c[k] for k in ("q", "choices", "answer", "explain")} | {"card": c["id"]} for c in cards],
                             answers={}, t=time.time(), review=True)
            await self.floor.say("quinn", "study", f"Review round: {len(cards)} cards you missed before. Second time's easier.", phase="quiz")
            return
        if not self.floor.brain.enabled:
            await self.floor.say("quinn", "chatter", "I need the AI brain on to write new questions.")
            return
        test = next((t for t in self.tasks() if t["test"] and t["days"] >= -3), None)
        course = test["course"] if test else ""
        about = topic or (f"{test['course']}: {test['title']}" if test else "intro financial accounting basics")
        self.busy = True
        asyncio.create_task(self._write_round(about, course))

    async def _write_round(self, about, course):
        f = self.floor
        try:
            await f.say("quinn", "study", f"Writing a 5-question practice round on {about[:80]}…", phase="writing")
            if re.search(r"account|macro|econ|financ", about, re.I):
                await f.board.post("study", "quinn", "fund", "request_fact", "Quinn here: I'd like one quiz question to use the fund's real numbers.")
            extra = f"\nOptionally make ONE question use these real numbers from Jason's AI paper-trading fund: {f.status_text()}" \
                if re.search(r"account|financ", about, re.I) else ""
            res = await asyncio.to_thread(f.brain.ask, QUIZ_SYSTEM, f"Topic: {about}{extra}", QUIZ_SCHEMA)
            qs = [x for x in res.get("questions", []) if len(x.get("choices", [])) == 4 and 0 <= int(x.get("answer", -1)) <= 3][:5]
            if not qs:
                raise LLMError("no usable questions came back")
            self.quiz = dict(id=f"q{time.time_ns()}", topic=res.get("topic", about)[:120], course=course, questions=qs, answers={}, t=time.time())
            await f.say("quinn", "study", f"Ready: \"{self.quiz['topic']}\". Open the Study tab whenever you want. No timer.", phase="ready")
        except LLMError as e:
            await f.say("quinn", "chatter", f"Couldn't write the round: {e}")
        finally:
            self.busy = False
            f.save()
            await f.push()

    async def answer(self, i, pick):
        q = self.quiz
        if not q or str(i) in q["answers"] or not 0 <= i < len(q["questions"]):
            return
        x = q["questions"][i]
        ok = int(pick) == int(x["answer"])
        q["answers"][str(i)] = int(pick)
        self.log.append(dict(t=time.time(), course=q["course"], ok=int(ok)))
        cid = x.get("card") or "c" + hashlib.md5(x["q"].encode()).hexdigest()[:12]     # stable across restarts
        card = next((c for c in self.deck if c["id"] == cid), None)
        if card is None:
            card = dict(id=cid, course=q["course"], box=1, due=0, **{k: x[k] for k in ("q", "choices", "answer", "explain")})
            self.deck.append(card)
        card["box"] = min(5, card["box"] + 1) if ok else 1                                # Leitner boxes
        card["due"] = time.time() + (2 ** (card["box"] - 1)) * 86400
        done = len(q["answers"]) == len(q["questions"])
        score = sum(int(q["answers"][k]) == int(q["questions"][int(k)]["answer"]) for k in q["answers"])
        msg = ("Correct!" if ok else "Not quite. It's in your review deck for tomorrow.") + (f" Round done: {score}/{len(q['questions'])}." if done else "")
        await self.floor.say("quinn", "study", msg, phase="answer", ok=ok, done=done,
                             score=sum(int(q["answers"][k]) == int(q["questions"][int(k)]["answer"]) for k in q["answers"]), of=len(q["questions"]))

    def extend(self, task_id, date):
        if day(date):
            self.ext[task_id] = str(day(date))
        else:
            self.ext.pop(task_id, None)
        self.plan = self.make_plan()

    # ── Remy answers on the Wire ──
    async def answer_inbox(self):
        f = self.floor
        self.answering = True
        try:
            for p in f.board.inbox("study"):
                if p["topic"] != "request":
                    f.board.ack(p, "remy")
                    continue
                if re.match(r"\s*quiz me", p["text"], re.I):
                    await self.new_round(re.sub(r"^\s*quiz me( on)?\s*", "", p["text"], flags=re.I) or None)
                    await f.board.reply(p, "quinn", "On it: a practice round is being written. It'll be in the Study tab in a minute.")
                    continue
                ans = None
                if f.brain.enabled:
                    try:
                        ans = (await asyncio.to_thread(f.brain.ask, TUTOR_SYSTEM, p["text"], TUTOR_SCHEMA)).get("answer")
                    except LLMError:
                        pass
                up = "; ".join(f"{t['course']} {t['title']} ({t['due']})" for t in self.tasks()[:4] if t["days"] >= 0)
                await f.board.reply(p, "remy", ans or f"My AI brain is off, so here's what's coming up instead: {up or 'nothing due'}.")
            f.save()
            await f.push()
        finally:
            self.answering = False
