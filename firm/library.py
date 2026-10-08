"""The Study Hall library: agents walk over and READ real finance and business material, then bring it back to work.

Every READ_EVERY_MIN one agent goes to the reading table in JB Study Hall. Claude (with web search) finds and reads
1-3 real sources on a topic that fits that agent's job, goal and recent failures, seeded from a reading list:
classic quant papers (SSRN / NBER), fresh arXiv q-fin papers (live RSS), and business classics for the studio staff.
They come back with notes, takeaways, cited sources, a lesson, and (for PMs) ONE concrete experiment for their own
strategy, which goes to the front of their trial-and-error queue (firm/trials.py). Nothing they read changes a trade
directly: ideas only get adopted after they win at the backtest machine."""
import asyncio
import random
import re
import time
import urllib.request

from .blocks import BLOCKS, block_schema, catalog, describe_rules
from .llm import LLMError
from .strategies import FAMILIES

READ_EVERY_MIN = 75
FIRST_READ_MIN = 8
ARXIV = ["https://rss.arxiv.org/rss/q-fin.TR", "https://rss.arxiv.org/rss/q-fin.PM", "https://rss.arxiv.org/rss/q-fin.ST"]

QUANT_CANON = [
    ("Time Series Momentum (Moskowitz, Ooi, Pedersen)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463"),
    ("A Century of Evidence on Trend-Following Investing (Hurst, Ooi, Pedersen)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2993026"),
    ("A Quantitative Approach to Tactical Asset Allocation (Faber)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461"),
    ("Volatility-Managed Portfolios (Moreira, Muir)", "https://www.nber.org/papers/w22208"),
    ("Value and Momentum Everywhere (Asness, Moskowitz, Pedersen)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2174501"),
    ("The Deflated Sharpe Ratio (Bailey, Lopez de Prado)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551"),
    ("...and the Cross-Section of Expected Returns (Harvey, Liu, Zhu)", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2249314"),
    ("Pairs Trading: Performance of a Relative-Value Arbitrage Rule (Gatev, Goetzmann, Rouwenhorst)", "https://www.nber.org/papers/w7032"),
    ("Momentum (finance): Jegadeesh-Titman and after", "https://en.wikipedia.org/wiki/Momentum_(finance)"),
    ("Kelly criterion and position sizing", "https://en.wikipedia.org/wiki/Kelly_criterion"),
    ("Short-term mean reversion with RSI(2) (Larry Connors)", ""),
    ("Turn-of-the-month and calendar effects in stock returns", ""),
    ("Crypto momentum and trend-following: academic evidence", ""),
    ("Stop-losses and trailing stops: do they help? (Kaminski, Lo 'When do stop-loss rules stop losses?')", ""),
    ("Market regimes: trend vs. chop, and how CTAs adapt", ""),
]
BUSINESS_CANON = [
    ("How to Get Startup Ideas (Paul Graham)", "https://paulgraham.com/startupideas.html"),
    ("Do Things that Don't Scale (Paul Graham)", "https://paulgraham.com/ds.html"),
    ("Startup = Growth (Paul Graham)", "https://paulgraham.com/growth.html"),
    ("The Startup Playbook (Sam Altman)", "https://playbook.samaltman.com/"),
    ("Y Combinator Startup Library", "https://www.ycombinator.com/library"),
    ("7 Powers (Hamilton Helmer): the sources of durable business advantage", ""),
    ("Pricing a small SaaS or service business: value-based pricing", ""),
    ("Unit economics: CAC, LTV, payback period for small businesses", ""),
    ("How AI agencies and automation shops find their first clients", ""),
]
BUSINESS_READERS = {"iris", "theo", "rosa"}

SYSTEM = ("You are an employee of JB Capital / JB Ventures (an AI-run fund and venture studio owned by Jason) spending an hour "
          "in the JB Study Hall library. Actually READ: search the web and open 1-3 credible, free sources (papers or their "
          "abstracts on SSRN/arXiv/NBER, reputable finance or business sites, well-known essays). Only cite URLs you opened. "
          "Take notes in plain words, be skeptical (academic effects often shrink after costs and publication), and connect what "
          "you read to YOUR job. If you trade, propose at most ONE concrete experiment for your own strategy using only the lego "
          "blocks / exit settings listed, or kind 'none'. Reply only with the JSON.")


def schema():
    exp = block_schema()
    exp["properties"].update({
        "kind": {"type": "string", "enum": ["add_filter", "change_exits", "none"]},
        "stop_atr": {"type": "number"}, "trail_atr": {"type": "number"}, "max_bars": {"type": "number"},
        "why": {"type": "string", "description": "max 25 words: what you read that suggests this"}})
    exp["properties"]["block"] = {"type": "string", "enum": list(BLOCKS) + ["none"]}
    exp["required"] = ["kind", "block", "why"]
    return {"type": "object", "properties": {
        "topic": {"type": "string", "description": "what you ended up reading about, max 8 words"},
        "sources": {"type": "array", "maxItems": 3, "items": {"type": "object", "properties": {
            "title": {"type": "string"}, "url": {"type": "string"}}, "required": ["title", "url"], "additionalProperties": False}},
        "notes": {"type": "string", "description": "max 90 words, your study notes"},
        "takeaways": {"type": "array", "maxItems": 3, "items": {"type": "string", "description": "max 18 words"}},
        "lesson": {"type": "string", "description": "the one lesson you will apply at work, max 25 words"},
        "experiment": exp},
        "required": ["topic", "sources", "notes", "takeaways", "lesson", "experiment"], "additionalProperties": False}


class Library:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.notes: list = st.get("notes", [])
        self.read: list = st.get("read", [])             # titles already read (rotate the reading list)
        self.turn: int = st.get("turn", 0)
        self.arxiv: list = []
        self.arxiv_at = 0.0
        self.next_at = time.time() + FIRST_READ_MIN * 60
        self.reading = None
        self.busy = False

    def to_state(self):
        return dict(notes=self.notes[-60:], read=self.read[-80:], turn=self.turn)

    def readers(self):
        f = self.floor
        pms = [a["id"] for a in f.roster if a["family"] in FAMILIES and a["family"] != "model" and a.get("tf") in ("1d", "1h")]
        others = ["ava", "rex", "vic", "opal"] + sorted(BUSINESS_READERS)
        return pms, others

    def pick_reader(self):
        """Two of every three sessions go to a PM (they can act on it); within a group, whoever read least recently."""
        pms, others = self.readers()
        self.turn += 1
        group = pms if pms and self.turn % 3 else others
        last = {n["aid"]: n["t"] for n in self.notes}
        return min(group, key=lambda a: (last.get(a, 0), random.random()))

    def fetch_arxiv(self):
        out = []
        for url in ARXIV:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "JB-Capital-StudyHall/1.0"})
                xml = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "ignore")
            except Exception:
                continue
            for item in re.findall(r"<item>(.*?)</item>", xml, re.S)[:15]:
                t = re.search(r"<title>(.*?)</title>", item, re.S)
                l = re.search(r"<link>(.*?)</link>", item, re.S)
                if t and l:
                    out.append((re.sub(r"\s+", " ", t.group(1)).strip(), l.group(1).strip()))
        return out

    async def seed(self, aid):
        if aid in BUSINESS_READERS:
            pool = BUSINESS_CANON
        else:
            if time.time() - self.arxiv_at > 12 * 3600:
                self.arxiv = await asyncio.to_thread(self.fetch_arxiv)
                self.arxiv_at = time.time()
            fresh = [x for x in self.arxiv if x[0] not in self.read]
            pool = (random.sample(fresh, min(2, len(fresh))) if fresh and random.random() < 0.4 else []) + QUANT_CANON
        unread = [x for x in pool if x[0] not in self.read] or pool
        return unread[0] if random.random() < 0.5 else random.choice(unread)

    async def step(self):
        f = self.floor
        if self.busy or not f.brain.enabled or time.time() < self.next_at or f.lab.running:
            return
        self.next_at = time.time() + READ_EVERY_MIN * 60
        self.busy = True
        asyncio.create_task(self._wrap(self.pick_reader()))

    async def read_now(self, aid=None):
        if self.busy or not self.floor.brain.enabled:
            return
        self.busy = True
        self.next_at = time.time() + READ_EVERY_MIN * 60
        asyncio.create_task(self._wrap(aid or self.pick_reader()))

    async def _wrap(self, aid):
        f = self.floor
        try:
            await self._session(aid)
        except Exception as e:      # never let the library crash the floor
            await f.say(aid, "chatter", f"Library trouble: {e!r}"[:140])
        finally:
            self.busy, self.reading = False, None
            f.save()
            await f.push()

    def _prompt(self, aid, title, url):
        f = self.floor
        p = f.minds.get(aid)
        pod = next((a for a in f.roster if a["id"] == aid), None)
        job = (f"You are {f.names.get(aid, aid)} ({p['role']}; personality: {p['traits']}). Goal: {p['goal'] or 'get better at my job'}.\n")
        if pod and pod["family"] in FAMILIES:
            job += (f"You trade this strategy on daily bars: {pod.get('desc', '')} on {pod.get('markets') or 'all markets'}.\n"
                    f"Backtest: {pod.get('bt', 'n/a')}\nYour trial-and-error record: {f.trials.summary(aid)}\n"
                    "Recent experiments: " + "; ".join(f"{e['what']} -> {e['verdict']}" for e in f.trials.me(aid)["log"][-5:]) + "\n"
                    f"\nLego blocks you may add as a filter (ALL filters must be true to enter):\n{catalog()}\n")
        elif aid in BUSINESS_READERS:
            job += "You work at JB Ventures, finding and scoring small AI-era businesses Jason could start. Read for business judgment.\n"
        else:
            job += "You support the fund's PMs (research, risk, volatility or options). Read for ideas the team can test.\n"
        mem = "; ".join(m["text"] for m in p["memories"][-6:]) or "nothing yet"
        les = "; ".join(l["text"] for l in p["lessons"][-4:]) or "none yet"
        done = "; ".join(f"{n['topic']}" for n in self.notes[-10:] if n["aid"] == aid) or "nothing yet"
        return (job + f"Recent memories: {mem}\nLessons so far: {les}\nYou already read: {done}\n\n"
                f"Suggested reading: {title}{' (' + url + ')' if url else ' (find a good source)'}. You may pick something "
                "else if your recent failures or goal call for it.")

    async def _session(self, aid):
        f = self.floor
        title, url = await self.seed(aid)
        name = f.names.get(aid, aid)
        self.reading = dict(aid=aid, name=name, title=title, t=time.time())
        await f.say(aid, "study_visit", f"Heading to the Study Hall library to read: {title}.", pause=3, step="go")
        try:
            out = await asyncio.to_thread(f.brain.ask, SYSTEM, self._prompt(aid, title, url), schema(), 600, True)
        except LLMError as e:
            await f.say(aid, "study_visit", f"Couldn't get through the reading ({e}). Back to my desk.", step="done")
            return
        self.read = (self.read + [title])[-80:]
        exp = out.get("experiment") or {}
        note = dict(t=time.time(), aid=aid, name=name, seed=title, topic=str(out.get("topic", title))[:80],
                    sources=[dict(title=str(s.get("title", ""))[:120], url=str(s.get("url", ""))[:300]) for s in out.get("sources", [])[:3]],
                    notes=str(out.get("notes", ""))[:700], takeaways=[str(x)[:160] for x in out.get("takeaways", [])[:3]],
                    lesson=str(out.get("lesson", ""))[:200], experiment=None)
        pod = next((a for a in f.roster if a["id"] == aid), None)
        if pod and pod["family"] in FAMILIES and exp.get("kind") in ("add_filter", "change_exits"):
            idea = dict(source=note["topic"], why=str(exp.get("why", ""))[:160])
            if exp["kind"] == "add_filter" and exp.get("block") in BLOCKS:
                idea.update(block=exp["block"], params={k: v for k, v in exp.items() if k in BLOCKS[exp["block"]][1]})
            for k in ("stop_atr", "trail_atr", "max_bars"):
                if exp.get(k):
                    idea[k] = exp[k]
            if "block" in idea or any(k in idea for k in ("stop_atr", "trail_atr", "max_bars")):
                f.trials.queue_idea(aid, idea)
                note["experiment"] = (describe_rules([dict(block=idea["block"], params=idea["params"])]) if "block" in idea else "") + \
                    ("change exits: " + ", ".join(f"{k}={idea[k]}" for k in ("stop_atr", "trail_atr", "max_bars") if k in idea) if "block" not in idea else "")
                f.trials.next_at = min(f.trials.next_at, time.time() + 60)    # test it soon
        self.notes = (self.notes + [note])[-60:]
        p = f.minds.get(aid)
        if note["lesson"]:
            p["lessons"] = (p["lessons"] + [dict(t=time.time(), text=note["lesson"], src=note["topic"])])[-12:]
        await f.minds.remember(aid, "study", f"Read about {note['topic']}" + (f"; will test: {note['experiment'][:80]}" if note["experiment"] else ""),
                               xp=15, valence=1)
        line = note["takeaways"][0] if note["takeaways"] else note["lesson"]
        await f.say(aid, "study_note", f"Back from the library ({note['topic']}). Takeaway: {line}"
                    + (" I'm testing it at the backtest machine next." if note["experiment"] else ""), pause=3, step="done")

    def lessons_for(self, ids):
        return [n for n in self.notes if n["aid"] in ids][-4:]

    def snapshot(self):
        return dict(notes=self.notes[-10:], reading=self.reading, next_in=max(0, int(self.next_at - time.time())))
