"""JB Newsroom: the third tower. It reads real news and feeds the rest of the city over the Wire.

  Nia (editor-in-chief)  - runs the desk, writes the hourly briefing, decides what's worth sending
  Ben (markets reporter) - pulls market + crypto feeds (CNBC, Yahoo Finance, CoinDesk, Cointelegraph)
  Lux (tech reporter)    - pulls AI/startup feeds (TechCrunch AI, The Verge AI, Hacker News)

With Alpaca keys, Ben also reads Benzinga's real-time wire every minute (free with an Alpaca account) and flags any
story about a market the fund holds to Rex. Every few minutes the reporters also fetch free RSS feeds (no keys). Headlines are deduped and tagged with the fund's
symbols by keyword. Every hour Nia writes a briefing (Claude when the brain is on, a keyword digest otherwise):
  - market news  -> the fund   (Ava reads it in her market report)
  - AI/startup trends -> the studio (Iris reads them when scouting)
  - a big market story -> Jason
Jason can also ask the newsroom on the Wire ("what's the news on BTC?")."""
import asyncio
import calendar
import html
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

import httpx

from . import config as C
from .llm import LLMError

FEEDS = {
    "markets": [("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
                ("CNBC Markets", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664"),
                ("Yahoo Finance", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY,QQQ,BTC-USD,GLD,TLT,USO&region=US&lang=en-US")],
    "crypto": [("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
               ("Cointelegraph", "https://cointelegraph.com/rss")],
    "tech": [("TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/"),
             ("The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"),
             ("Hacker News", "https://hnrss.org/frontpage")],
}
REPORTER = {"markets": "ben", "crypto": "ben", "tech": "lux"}
BENZINGA = "https://data.alpaca.markets/v1beta1/news"
ALP_SYM = {"BTCUSD": "BTC", "ETHUSD": "ETH", "SOLUSD": "SOL", "BTC/USD": "BTC", "ETH/USD": "ETH", "SOL/USD": "SOL"}

# keyword -> fund symbol (simple, transparent tagging; the LLM briefing does the real reading)
TAGS = {
    "BTC": r"\bbitcoin|\bbtc\b", "ETH": r"\bether(eum)?\b|\beth\b", "SOL": r"\bsolana\b|\bsol\b",
    "SPY": r"s&p ?500|\bstocks?\b|wall street|\bdow\b", "QQQ": r"nasdaq|tech stocks", "NVDA": r"nvidia|\bnvda\b",
    "TLT": r"treasur|bond yields?|\byields?\b|\bfed\b|rate cut|rate hike|powell|inflation|\bcpi\b",
    "GLD": r"\bgold\b", "SLV": r"\bsilver\b", "USO": r"\boil\b|crude|opec|brent", "XLE": r"\benergy\b",
    "XLF": r"\bbanks?\b|jpmorgan|goldman", "EEM": r"emerging markets?|china|india", "VNQ": r"real estate|housing|mortgage",
    "HYG": r"junk bonds?|high.yield|credit spreads?", "IWM": r"small.caps?|russell",
}
TAG_RX = {s: re.compile(rx, re.I) for s, rx in TAGS.items()}
BIG = re.compile(r"plunge|crash|tumble|selloff|sell-off|halted|bankrupt|emergency|surprise rate|default|exploit|hacked", re.I)   # shocks only

BRIEF_SCHEMA = {"type": "object", "properties": {
    "headline": {"type": "string", "description": "the single most important story right now, one sentence"},
    "market_brief": {"type": "string", "description": "for the trading desk: 3-5 short bullet-style sentences on market-moving news, naming the affected symbols"},
    "symbols": {"type": "array", "items": {"type": "object", "properties": {
        "sym": {"type": "string"}, "tone": {"type": "number", "description": "-1 bad news .. +1 good news for this symbol, 0 neutral"},
        "why": {"type": "string", "description": "max 12 words"}}, "required": ["sym", "tone", "why"], "additionalProperties": False}},
    "trends": {"type": "string", "description": "for the venture studio: 2-4 sentences on AI/startup trends and new opportunities in the tech news"},
    "alert_jason": {"type": "boolean", "description": "true only for a genuinely big market story he should know about now"}},
    "required": ["headline", "market_brief", "symbols", "trends", "alert_jason"], "additionalProperties": False}
EDITOR_SYSTEM = ("You are Nia, editor-in-chief of JB Newsroom, the news desk serving an AI hedge fund (paper trading) and a "
                 "small venture studio. You get today's real headlines from RSS feeds. Summarize ONLY what the headlines say: "
                 "never invent facts, numbers or stories. Separate signal from noise; most headlines don't move markets. "
                 "Reply only with the JSON.")
ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "description": "max 100 words, plain text"}},
                 "required": ["answer"], "additionalProperties": False}
ANSWER_SYSTEM = ("You are Nia, editor of JB Newsroom. Jason (the founder) asked a question. Answer briefly using ONLY the "
                 "headlines provided; name the source. If the headlines don't cover it, say so. Reply only with the JSON.")


def datetime_ts(s):
    try:
        return calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S"))      # Alpaca timestamps are UTC
    except ValueError:
        return time.time()


def _text(el, tag):
    x = el.find(tag)
    if x is None:
        x = el.find("{http://www.w3.org/2005/Atom}" + tag)
    if x is None:
        return ""
    if tag == "link" and x.get("href"):
        return x.get("href")
    return html.unescape(re.sub(r"<[^>]+>", "", (x.text or "").strip()))


def parse_feed(xml: bytes, source: str, desk: str):
    out = []
    root = ET.fromstring(xml)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    for it in items[:30]:
        title = _text(it, "title")
        if not title:
            continue
        ts = time.time()
        for tag in ("pubDate", "published", "updated"):
            raw = _text(it, tag)
            if raw:
                try:
                    ts = parsedate_to_datetime(raw).timestamp()
                except (TypeError, ValueError):
                    try:
                        ts = time.mktime(time.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S"))
                    except ValueError:
                        pass
                break
        summary = _text(it, "description") or _text(it, "summary")
        text = f"{title} {summary}"
        tags = [s for s, rx in TAG_RX.items() if rx.search(text)] if desk != "tech" else []
        out.append(dict(id=re.sub(r"\W+", "", title.lower())[:80], title=title[:220], summary=summary[:300],
                        link=_text(it, "link")[:300], source=source, desk=desk, t=ts, tags=tags, big=bool(BIG.search(title))))
    return out


class Newsroom:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.items: list = st.get("items", [])
        self.briefs: list = st.get("briefs", [])
        self.status = "idle"
        self.errors: list = []
        self.last_fetch = 0.0
        self.next_brief = time.time() + C.NEWS_FIRST_BRIEF_SEC
        self.running = False
        self.answering = False
        self.last_alert = st.get("last_alert", 0.0)
        self.fast_since = st.get("fast_since") or time.time() - 6 * 3600
        self.last_fast = 0.0
        self.last_fast_say = 0.0

    def to_state(self):
        return dict(items=self.items[-300:], briefs=self.briefs[-30:], last_alert=self.last_alert, fast_since=self.fast_since)

    def latest(self, desk=None, n=12, since_h=24):
        cut = time.time() - since_h * 3600
        xs = [x for x in self.items if x["t"] >= cut and (desk is None or x["desk"] in desk)]
        return sorted(xs, key=lambda x: -x["t"])[:n]

    def snapshot(self):
        b = self.briefs[-1] if self.briefs else None
        return dict(status=self.status, headlines=[{k: x[k] for k in ("title", "source", "desk", "t", "tags", "big", "link")}
                                                   for x in self.latest(n=24)],
                    brief=b, errors=self.errors[-3:], next_brief_in=max(0, int(self.next_brief - time.time())),
                    count=len(self.items))

    # ── Ben's real-time wire: Benzinga via Alpaca, every minute ──
    async def fetch_fast(self):
        if not (C.ALPACA_KEY and C.ALPACA_SECRET):
            return []
        start = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.fast_since))
        try:
            async with httpx.AsyncClient(timeout=10, headers={"APCA-API-KEY-ID": C.ALPACA_KEY, "APCA-API-SECRET-KEY": C.ALPACA_SECRET}) as cl:
                r = await cl.get(BENZINGA, params={"limit": 50, "sort": "desc", "start": start})
                r.raise_for_status()
        except Exception as e:
            self.errors = (self.errors + [f"Benzinga: {type(e).__name__}"])[-3:]
            return []
        seen = {x["id"] for x in self.items}
        new = []
        for n in r.json().get("news", []):
            title = html.unescape(n.get("headline", "")).strip()
            iid = re.sub(r"\W+", "", title.lower())[:80]
            if not title or iid in seen:
                continue
            ts = datetime_ts(n.get("created_at"))
            self.fast_since = max(self.fast_since, ts + 1)
            text = f"{title} {n.get('summary', '')}"
            tags = sorted({ALP_SYM.get(s, s) for s in n.get("symbols", []) if ALP_SYM.get(s, s) in C.INST} |
                          {s for s, rx in TAG_RX.items() if rx.search(text)})
            seen.add(iid)
            new.append(dict(id=iid, title=title[:220], summary=html.unescape(n.get("summary", ""))[:300], link=n.get("url", "")[:300],
                            source="Benzinga", desk="markets", t=ts, tags=tags, big=bool(BIG.search(title)), fast=True))
        if new:
            self.items = sorted(self.items + new, key=lambda x: x["t"])[-300:]
        return new

    async def flash(self, new):
        """Real-time stories: tell the floor, and flag anything about a market the fund holds to Rex."""
        f = self.floor
        held = {p["sym"] for p in f.broker.positions.values()}
        hits = [x for x in new if held & set(x["tags"])]
        if hits:
            x = hits[0]
            syms = sorted(held & set(x["tags"]))
            await f.board.post("news", "ben", "fund", "news_flash", f"Breaking on {', '.join(syms)} (we hold it): {x['title']}"[:600],
                               data=dict(syms=syms, link=x["link"]))
        elif time.time() - self.last_fast_say > 300 and any(x["tags"] for x in new):
            self.last_fast_say = time.time()
            x = max(new, key=lambda x: (x["big"], len(x["tags"])))
            await f.say("ben", "news", f'Wire: "{x["title"]}" ({", ".join(x["tags"]) or "Benzinga"})'[:240], desk="markets", tags=x["tags"], big=x["big"])

    # ── the reporters: fetch + dedupe ──
    async def fetch(self):
        self.status = "fetching"
        self.errors = []
        seen = {x["id"] for x in self.items}
        new = []
        async with httpx.AsyncClient(headers={"User-Agent": "Mozilla/5.0 (jb-newsroom/1.0)"}, timeout=15, follow_redirects=True) as cl:
            jobs = [(desk, src, url) for desk, feeds in FEEDS.items() for src, url in feeds]
            res = await asyncio.gather(*(cl.get(u) for _, _, u in jobs), return_exceptions=True)
        for (desk, src, _), r in zip(jobs, res):
            try:
                if isinstance(r, Exception):
                    raise r
                r.raise_for_status()
                for x in parse_feed(r.content, src, desk):          # bytes: the XML declares its own encoding
                    if x["id"] and x["id"] not in seen and time.time() - x["t"] < 48 * 3600:
                        seen.add(x["id"])
                        new.append(x)
            except Exception as e:  # one bad feed never stops the desk
                self.errors.append(f"{src}: {type(e).__name__}")
        self.items = sorted(self.items + new, key=lambda x: x["t"])[-300:]
        self.last_fetch = time.time()
        self.status = "idle"
        return new

    async def step(self):
        """Called every floor loop. Cheap unless a fetch or briefing is due."""
        f = self.floor
        if self.running:
            return
        if time.time() - self.last_fast >= C.NEWS_FAST_SEC:
            self.last_fast = time.time()
            fresh = await self.fetch_fast()
            if fresh:
                await self.flash(fresh)
        if time.time() - self.last_fetch > C.NEWS_FETCH_MIN * 60:
            self.running = True
            try:
                new = await self.fetch()
                if new:
                    by = {}
                    for x in new:
                        by.setdefault(REPORTER[x["desk"]], []).append(x)
                    for who, xs in by.items():
                        top = max(xs, key=lambda x: (x["big"], len(x["tags"]), x["t"]))
                        await f.say(who, "news", f'{len(xs)} new stories. Top: "{top["title"]}" ({top["source"]})'[:240],
                                    desk=top["desk"], tags=top["tags"], big=top["big"])
                firms = f.career.watch_firms()
                hits = []
                for x in new:
                    firm = next((n for n in firms if re.search(r"\b" + re.escape(n) + r"\b", x["title"])), None)
                    if firm and x["desk"] != "tech":
                        hits.append(dict(x, firm=firm))
                added = f.career.note_firm_news(hits)
                if added:
                    await f.board.post("news", "ben", "career", "firm_news", "Firms on your list in the news: "
                                       + "; ".join(f"{x['firm']}: {x['title']}" for x in added[:3])[:560])
                for e in self.errors[:2]:
                    await f.say("ben", "chatter", f"Feed trouble: {e}")
            finally:
                self.running = False
            f.save()
            await f.push()
        if time.time() >= self.next_brief and self.items:
            self.next_brief = time.time() + C.NEWS_BRIEF_MIN * 60
            self.running = True
            asyncio.create_task(self._brief_wrap())
        if f.board.inbox("news") and not self.answering:
            asyncio.create_task(self.answer_inbox())

    # ── Nia's hourly briefing ──
    async def _brief_wrap(self):
        try:
            await self.briefing()
        except Exception as e:
            await self.floor.say("nia", "chatter", f"Briefing hiccup: {e!r}"[:140])
        finally:
            self.running = False
            self.status = "idle"
            self.floor.save()
            await self.floor.push()

    def _lines(self, desks, n):
        return "\n".join(f"- [{x['source']}] {x['title']}" + (f" ({', '.join(x['tags'])})" if x["tags"] else "")
                         for x in self.latest(desks, n, since_h=12))

    async def briefing(self):
        f = self.floor
        self.status = "writing"
        await f.say("nia", "news", "Editorial meeting. Ben, Lux: what have we got?", phase="meeting")
        mk, tech = self._lines(("markets", "crypto"), 30), self._lines(("tech",), 20)
        if not mk and not tech:
            return
        b = None
        if f.brain.enabled:
            try:
                b = await asyncio.to_thread(f.brain.ask, EDITOR_SYSTEM,
                                            f"Fund symbols: {', '.join(C.INST)}\n\n## Market + crypto headlines (last 12h)\n{mk or '- none'}"
                                            f"\n\n## AI / tech headlines (last 12h)\n{tech or '- none'}", BRIEF_SCHEMA)
            except LLMError as e:
                await f.say("nia", "chatter", f"No AI help today ({e}). Writing the digest by hand.")
        if b is None:
            b = self._digest()
        b["t"] = time.time()
        b["symbols"] = [s for s in b.get("symbols", []) if s.get("sym") in C.INST][:8]
        self.briefs.append(b)
        self.briefs = self.briefs[-30:]
        await f.say("nia", "news", f"Briefing: {b['headline']}"[:240], phase="brief", big=bool(b.get("alert_jason")))
        await f.board.post("news", "ben", "fund", "news_brief", b["market_brief"][:600],
                           data=dict(symbols=b["symbols"], headline=b["headline"]))
        if b.get("trends"):
            await f.board.post("news", "lux", "studio", "trends", b["trends"][:600])
        if b.get("alert_jason") and time.time() - self.last_alert > 6 * 3600:     # at most one ping every 6 hours
            self.last_alert = time.time()
            await f.board.post("news", "nia", "jason", "alert", f"Big story: {b['headline']}"[:600])

    def _digest(self):
        """No AI brain: a plain keyword digest so the desk still delivers."""
        mk, tech = self.latest(("markets", "crypto"), 30, 12), self.latest(("tech",), 12, 12)
        tagged = [x for x in mk if x["tags"]]
        top = (sorted(mk, key=lambda x: (x["big"], len(x["tags"]), x["t"]), reverse=True) or [None])[0]
        counts = {}
        for x in tagged:
            for s in x["tags"]:
                counts[s] = counts.get(s, 0) + 1
        hot = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
        return dict(headline=(f"{top['title']} ({top['source']})" if top else "Quiet news day."),
                    market_brief=("Most-mentioned symbols: " + ", ".join(f"{s} ({n})" for s, n in hot) + ". Top stories: "
                                  + "; ".join(x["title"] for x in tagged[:3])) if hot else "No market-moving headlines tagged.",
                    symbols=[dict(sym=s, tone=0.0, why=f"{n} headlines (keyword digest, tone not judged)") for s, n in hot],
                    trends=("Tech headlines: " + "; ".join(x["title"] for x in tech[:4])) if tech else "",
                    alert_jason=False)                     # keywords can't judge what's breaking; only the AI briefing alerts

    # ── questions on the Wire ──
    async def answer_inbox(self):
        f = self.floor
        self.answering = True
        try:
            for p in f.board.inbox("news"):
                words = [w for w in re.findall(r"[a-z0-9&]+", p["text"].lower()) if len(w) > 2]
                hits = [x for x in self.latest(n=200, since_h=48)
                        if any(w in x["title"].lower() or w.upper() in x["tags"] for w in words)][:12] or self.latest(n=10)
                lines = "\n".join(f"- [{x['source']}] {x['title']}" for x in hits)
                ans = None
                if f.brain.enabled:
                    try:
                        ans = (await asyncio.to_thread(f.brain.ask, ANSWER_SYSTEM, f"Headlines:\n{lines}\n\nJason asks: {p['text']}",
                                                       ANSWER_SCHEMA)).get("answer")
                    except LLMError:
                        ans = None
                await f.board.reply(p, "nia", ans or ("Latest on that:\n" + lines)[:1400])
            f.save()
            await f.push()
        finally:
            self.answering = False

    def brief_for(self, topic):
        """Latest briefing text for other towers' prompts."""
        if not self.briefs:
            return ""
        b = self.briefs[-1]
        if time.time() - b["t"] > 6 * 3600:
            return ""
        return b["market_brief"] if topic == "market" else b.get("trends", "")
