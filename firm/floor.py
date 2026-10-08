"""JB Capital, an AI multi-strategy hedge fund (paper). Multi-manager "pod" model:
  - every quant is a Portfolio Manager (PM) running a pod: own capital, own trades, own P&L
  - the CIO allocates capital to pods by earned trust; the CRO shuts down pods that lose too much
  - Ava (AI) writes market views, runs the R&D lab that hires new PMs, and drafts investor letters
Each step emits an event that the 3D office shows as an animation."""
import asyncio
import copy
import json
import os
import random
import time

from . import config as C
from .analyst import SCHEMA as VIEW_SCHEMA, SYSTEM as VIEW_SYSTEM
from .broker import Broker, pos_key
from .alpaca import AlpacaMirror
from .data import DataDesk, indicators
from .fund import metrics, allocate
from .llm import Brain, LLMError
from . import options as OPT
from .research import Lab
from .minds import Minds
from .trials import Trials
from .library import Library
from .overlap import OverlapDesk
from .riskbook import RiskBook
from .toolbox import Toolbox
from .incubator import Incubator
from .ops import Ops
from .arena import Arena
from .mydesk import MyDesk, POD as MY_POD
from .askdesk import AskDesk
from .builder import Builder
from .digest import Digest
from .cio import CIO
from .quant.modellab import ModelLab
from .voldesk import ETFVolDesk
from .compliance import Compliance
from .riskreport import RiskReport
from .fundops import FundOps
from .experiment import Experiment
from . import tearsheet
from .riskbook import group_of
from .stockopts import MULT as OPT_MULT
from .stockopts import StockOptions, optionable
from .hourly import HourlyDesk
from .studio import Studio
from .newsroom import Newsroom
from .career import Career
from .gex import GexDesk
from .study import StudyHall
from .unlocks import Unlocks
from .cityhall import CityHall
from .city import Board, BUILDINGS
from .scorekeeper import Scorekeeper
from .strategies import FOUNDERS, live_call, describe

STAFF = {"dot": "Dot", "vic": "Vic", "ava": "Ava", "boss": "The CIO", "rex": "Rex", "eddie": "Eddie", "sam": "Sam",
         "iris": "Iris", "theo": "Theo", "rosa": "Rosa", "nia": "Nia", "ben": "Ben", "lux": "Lux", "cole": "Cole", "maya": "Maya", "drew": "Drew", "sage": "Sage", "quinn": "Quinn", "remy": "Remy", "jason": "Jason",
         "juno": "Juno", "nova": "Nova", "kip": "Kip", "kai": "Kai", "lena": "Lena", "ari": "Ari"}   # juno runs the Incubator tower; nova + kip run the Ops Center
OPAL = dict(id="opal", name="Opal", family="options", founder=True, params={}, markets=["BTC", "ETH"],
            desc="sells rich vol (iron condors), buys cheap vol (calls/puts) on Deribit")

LETTER_SCHEMA = {"type": "object", "properties": {
    "title": {"type": "string", "description": "short headline for the letter"},
    "body": {"type": "string", "description": "the letter, 120-200 words, plain text, 2-3 short paragraphs"}},
    "required": ["title", "body"], "additionalProperties": False}
ANSWER_SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "description": "the reply, max 120 words, plain text"}},
                 "required": ["answer"], "additionalProperties": False}
ANSWER_SYSTEM = ("You are the CIO of JB Capital, an AI-run hedge fund that PAPER trades. Jason, the founder, messaged you (often from "
                 "his phone). Answer briefly and honestly from the fund status you're given; if you don't know, say so. You cannot place "
                 "trades or change settings from this channel; tell him to use the dashboard for that. Reply only with the JSON.")
LETTER_SYSTEM = ("You are the CIO of JB Capital, an AI-run multi-strategy hedge fund that is PAPER trading (simulated money). "
                 "Write a short, honest update to investors: performance, what the pods did, what the research lab learned, "
                 "risk posture, and what's next. Never hype; if results are small or negative, say so plainly. Reply only with the JSON.")


def fmt(px):
    return f"{px:,.2f}" if px < 1000 else f"{px:,.0f}"


def qty_round(q, step):
    return int(q / step) * step if step >= 1 else round(int(q / step) * step, 8)


class Floor:
    def __init__(self, emit, snapshot):
        self.emit_cb, self.snapshot_cb = emit, snapshot
        st = self._load()
        self.broker = Broker(st.get("broker"))
        self.alpaca = AlpacaMirror(st.get("alpaca"))
        self.score = Scorekeeper(st.get("score"))
        self.curve: list = st.get("curve", [])
        self.day_start: dict = st.get("day_start", {})
        self.roster: list = st.get("roster") or copy.deepcopy(FOUNDERS)
        if not any(a["id"] == "opal" for a in self.roster):
            self.roster.insert(2, copy.deepcopy(OPAL))
        for a in self.roster:
            a.setdefault("desc", describe(a["family"], a["params"]) if a["family"] != "options" else OPAL["desc"])
        self.names = {**STAFF, MY_POD: "Jason", **{a["id"]: a["name"] for a in self.roster}}
        self.desk = DataDesk()
        self.hdesk = HourlyDesk()
        self.brain = Brain()
        self.views: dict = {}
        self.headline = ""
        self.last_bar: dict = st.get("last_daily", {})   # "d:SYM" keys persist so a restart doesn't re-fire a day's signal
        self.last_analysis = time.time() - (C.ANALYST_EVERY_MIN - 5) * 60
        self.vic_regime: dict = {}
        self.busy = False
        self.benched: set = set(st.get("benched", []))
        self.stopped: dict = st.get("stopped", {})        # pod -> reason (CRO drawdown stop)
        self.pod_peak: dict = st.get("pod_peak", {})      # pod -> best P&L so far
        self.pod_hist: dict = st.get("pod_hist", {})      # pod -> [[t, P&L], ...] every 30 minutes
        self.games: dict = st.get("games", {})            # Jason's mini-games (Math Arena scores)
        self.last_pod_hist = 0.0
        self.alloc: dict = {}
        self.dup: dict = {}               # pod -> how many 'copies' of its bet the team holds (Dot's report)
        self.last_realloc_msg = 0.0
        self.letters: list = st.get("letters", [])
        self.writing_letter = False
        self.settings: dict = {}
        for k, v in st.get("settings", {}).items():
            self.apply_setting(k, v)
        self.lab = Lab(self, st)
        self.minds = Minds(self, st.get("minds", {}))
        self.trials = Trials(self, st.get("trials", {}))
        self.library = Library(self, st.get("library", {}))
        self.overlap = OverlapDesk(self, st.get("overlap", {}))
        self.sopt = StockOptions(self, st.get("stockopts", {}))
        self.riskbook = RiskBook(self)
        self.toolbox = Toolbox(self, st.get("toolbox", {}))
        self.incubator = Incubator(self, st.get("incubator", {}))
        self.ops = Ops(self)
        self.arena = Arena(self, st.get("arena", {}))
        self.mydesk = MyDesk(self)
        self.askdesk = AskDesk(self)
        self.builder = Builder(self, st.get("builder", {}))
        self.digest = Digest(self, st.get("digest"))
        self.cio = CIO(self, st.get("cio", {}))
        self.mlab = ModelLab(self, st.get("mlab", {}))
        self.voldesk = ETFVolDesk(self)
        self.compliance = Compliance(self, st.get("compliance", {}))
        self.riskrep = RiskReport(self, st.get("riskrep", {}))
        self.fundops = FundOps(self, st.get("fundops", {}))
        self.experiment = Experiment(self, st.get("experiment", {}))
        self.size_note = ""
        self.studio = Studio(self, st.get("studio", {}))
        self.board = Board(self, st.get("wire"))
        self.news = Newsroom(self, st.get("news", {}))
        self.career = Career(self, st.get("career", {}))
        self.gex = GexDesk(self, st.get("gex", {}))
        self.study = StudyHall(self, st.get("study", {}))
        self.unlocks = Unlocks(self, st.get("unlocks", {}))
        self.cityhall = CityHall(self)
        self.answering = False
        self.chain = OPT.Chain()
        self.vol: dict = {}
        self._opal_bar: dict = {}
        self.last_huddle = time.time() - (C.HUDDLE_EVERY_MIN - 3) * 60   # first huddle ~3 min after start
        self.reallocate(announce=False)

    # ── live controls from the game (CIO desk, pod cards) ──
    LIMITS = {"RISK_PER_TRADE": (0.005, 0.05), "MAX_TOTAL_RISK": (0.01, 0.2),
              "MAX_POSITIONS": (1, 20), "POD_DD_LIMIT": (0.02, 0.25),
              "MAX_SYM_NOTIONAL": (0.05, 0.5), "MAX_GROUP_NOTIONAL": (0.1, 1.0),
              "MAX_POD_RISK": (0.01, 0.2), "RISK_APPETITE": (0.25, 1.0), "MAX_GROSS": (1.0, 2.0)}
    LABELS = {"RISK_PER_TRADE": "starting risk per trade (unproven pods)", "MAX_TOTAL_RISK": "fund risk cap",
              "MAX_POD_RISK": "CIO's max risk per trade for a pod", "RISK_APPETITE": "risk appetite (share of Kelly)",
              "MAX_GROSS": "max gross exposure (margin)",
              "MAX_POSITIONS": "max positions", "POD_DD_LIMIT": "pod drawdown limit",
              "MAX_SYM_NOTIONAL": "fund limit per market", "MAX_GROUP_NOTIONAL": "fund limit per market group"}

    # one-click risk policies (the CIO desk's presets); "pod_shop" is the recommended one
    PRESETS = {
        "pod_shop": dict(label="Pod shop (recommended)", RISK_APPETITE=0.5, MAX_POD_RISK=0.02, MAX_GROSS=1.0, RISK_PER_TRADE=0.0075, MAX_TOTAL_RISK=0.08,
                         POD_DD_LIMIT=0.10, MAX_POSITIONS=20, MAX_SYM_NOTIONAL=0.25, MAX_GROUP_NOTIONAL=0.5),
        "aggressive": dict(label="Aggressive paper", RISK_APPETITE=0.75, MAX_POD_RISK=0.04, MAX_GROSS=1.25, RISK_PER_TRADE=0.015, MAX_TOTAL_RISK=0.12,
                           POD_DD_LIMIT=0.15, MAX_POSITIONS=20, MAX_SYM_NOTIONAL=0.35, MAX_GROUP_NOTIONAL=0.6),
        "max": dict(label="Max (every slider at the top)", RISK_APPETITE=1.0, MAX_POD_RISK=0.2, MAX_GROSS=2.0, RISK_PER_TRADE=0.05, MAX_TOTAL_RISK=0.2,
                    POD_DD_LIMIT=0.25, MAX_POSITIONS=20, MAX_SYM_NOTIONAL=0.5, MAX_GROUP_NOTIONAL=1.0),
    }

    def apply_setting(self, key, value):
        if key not in self.LIMITS:
            return False
        lo, hi = self.LIMITS[key]
        v = max(lo, min(hi, float(value)))
        if key == "MAX_POSITIONS":
            v = int(v)
        setattr(C, key, v)
        self.settings[key] = v
        return True

    async def control(self, msg: dict):
        kind, a = msg.get("type"), msg.get("agent")
        if kind == "set" and self.apply_setting(msg.get("key"), msg.get("value", 0)):
            v = self.settings[msg["key"]]
            self.experiment.change(f"Risk policy: {self.LABELS.get(msg['key'], msg['key'])} set to {v:g}")
            await self.say("boss", "system", f"New policy: max positions is now {v}." if msg["key"] == "MAX_POSITIONS"
                           else f"New policy: {self.LABELS[msg['key']]} is now {v:.2g}x NAV." if msg["key"] == "MAX_GROSS"
                           else f"New policy: {self.LABELS[msg['key']]} is now {v:.1%}.")
        elif kind == "bench" and (a in self.ids() or a == "ava"):
            if msg.get("on"):
                self.benched.add(a)
                await self.say("boss", "system", f"{self.names[a]}, your pod is paused. Capital goes back to the pool.")
            else:
                self.benched.discard(a)
                self.stopped.pop(a, None)
                self.pod_peak[a] = self.broker.pod_pnl(a, self.prices())        # the drawdown clock restarts from here
                await self.say("boss", "system", f"{self.names[a]}, you're back on. Fresh risk budget.")
            self.reallocate()
        elif kind == "research_now":
            self.lab.next_at = 0
            await self.say("boss", "system", "Ava, get to the lab. I want new strategies NOW.")
            await self.lab.maybe_run()
        elif kind == "arena_call":                 # Beat the Bots: Jason calls a market's direction
            try:
                await self.arena.call(str(msg.get("sym", "")), int(msg.get("dir", 0)))
            except (TypeError, ValueError):
                return
            await self.push()
        elif kind == "math":                       # the Study Hall's Math Arena (a Zetamac-style drill)
            try:
                s, best = max(0, min(300, int(msg.get("score", 0)))), max(0, min(300, int(msg.get("best", 0))))
            except (TypeError, ValueError):
                return
            runs = self.games.setdefault("math", [])
            runs.append([int(time.time()), s]); self.games["math"] = runs[-200:]
            await self.say("quinn", "math", f"Math Arena: Jason scored {s}." + (" A new personal best!" if s >= best and s > 0 else f" Best is {best}.")
                           + " A common prop-firm interview target is 40+ in 120 seconds.", pause=1)
        elif kind == "build_test":                 # the Strategy Builder: Jason's own idea through the lab's gate
            asyncio.create_task(self.builder.test(msg))
            return
        elif kind == "build_submit":
            await self.builder.submit()
        elif kind == "ask":                        # Jason asks an agent something, in person
            asyncio.create_task(self.askdesk.ask(str(msg.get("agent", "")), msg.get("text", "")))
            return
        elif kind == "mm":                         # the Study Hall's Market Making Pit (sum of four dice vs Quinn)
            try:
                s, best = max(-200, min(200, int(msg.get("score", 0)))), max(-200, min(200, int(msg.get("best", 0))))
            except (TypeError, ValueError):
                return
            runs = self.games.setdefault("mm", [])
            runs.append([int(time.time()), s]); self.games["mm"] = runs[-200:]
            await self.say("quinn", "math", f"Market Making Pit: Jason finished {'+' if s >= 0 else ''}{s} over five games against me."
                           + (" New best!" if s >= best and s > 0 else f" Best is {'+' if best >= 0 else ''}{best}.")
                           + (" I couldn't pick you off: that's how a market maker earns the spread." if s > 0 else
                              " I picked you off: quote around the expected value and skew away from your fills."), pause=1)
        elif kind == "model_test":                 # Jason builds a model in the Model Lab
            await self.mlab.jason_test(msg)
            return
        elif kind == "preset" and msg.get("name") in self.PRESETS:
            p = self.PRESETS[msg["name"]]
            self.experiment.change(f"Risk policy switched to {p['label']}")
            for k, v in p.items():
                if k != "label":
                    self.apply_setting(k, v)
            self.reallocate(announce=False)
            await self.say("boss", "system", f"New risk policy: {p['label']}. {p['RISK_PER_TRADE']:.2%} starting risk per trade (CIO max {p['MAX_POD_RISK']:.0%}), "
                           f"fund risk cap {p['MAX_TOTAL_RISK']:.0%}, pod drawdown stop {p['POD_DD_LIMIT']:.0%}, {p['MAX_GROSS']:.2g}x gross, "
                           f"{p['MAX_SYM_NOTIONAL']:.0%} per market / {p['MAX_GROUP_NOTIONAL']:.0%} per group. Rex trims anything over the new limits at the open.", pause=2)
        elif kind == "exp_save":                   # Jason saves an experiment update (the next one compares against it)
            self.experiment.save(msg.get("note", ""))
        elif kind == "exp_note":
            if str(msg.get("text", "")).strip():
                self.experiment.change("Jason: " + str(msg["text"]).strip())
        elif kind == "restrict":                   # Jason edits the restricted list (compliance)
            self.experiment.change(f"Compliance: {str(msg.get('sym', '')).upper()} {'restricted' if msg.get('on', True) else 'lifted'}")
            await self.compliance.restrict(msg.get("sym", ""), bool(msg.get("on", True)), msg.get("why", ""))
        elif kind == "announce":                   # Jason at the podium: a floor announcement, with optional directives
            self.experiment.change("Announcement: " + (str(msg.get("text", "")).strip() or "(directives only)")
                                   + "".join(f" [{k}: {msg[k]}]" for k in ("stance", "pause") if msg.get(k)) + (" [research sprint]" if msg.get("sprint") else ""))
            await self.cio.announce(msg)
            return
        elif kind == "manage":                     # Jason manages a PM: shout-out, warning, boost, send to the lab
            self.experiment.change(f"Team: {msg.get('action')} for {self.names.get(msg.get('agent'), msg.get('agent'))}")
            await self.cio.manage(msg)
            return
        elif kind == "priority_drop":
            self.cio.priorities = [p for p in self.cio.priorities if p["id"] != msg.get("id")]
        elif kind == "cio_plan":
            await self.cio.maybe_plan(force=True)
        elif kind == "my_order":                   # Jason's own desk: he trades alongside the PMs
            await self.mydesk.order(msg)
        elif kind == "my_close":
            await self.mydesk.close(str(msg.get("key", "")))
        elif kind == "my_breakeven":
            await self.mydesk.breakeven(str(msg.get("key", "")))
        elif kind == "broker":
            on = bool(msg.get("on"))
            if on and not self.alpaca.configured:
                await self.say("eddie", "system", "No Alpaca keys yet. Put them in ai-trading-floor/.env and restart.")
                return
            self.alpaca.enabled = on
            if on:
                self.alpaca.killed = None
                self.alpaca.last_sync = 0
            await self.say("boss", "system", "Broker link ON: Eddie mirrors the fund to Alpaca." if on
                           else "Broker link OFF: no more orders go to Alpaca. Positions there stay as they are.")
        elif kind == "studio_now":
            if self.studio.running:
                return
            await self.say("rosa", "studio", "Calling a studio meeting now.", phase="start")
            await self.studio.maybe_run(force=True)
        elif kind == "wire":
            await self.jason_says(msg.get("to", ""), msg.get("text", ""))
        elif kind == "quiz_new":
            await self.study.new_round(str(msg.get("topic") or "").strip()[:200] or None)
        elif kind == "quiz_answer":
            await self.study.answer(int(msg.get("i", -1)), int(msg.get("pick", -1)))
        elif kind == "study_extend":
            self.study.extend(str(msg.get("task", "")), str(msg.get("date", "")))
        elif kind == "stockopts":
            self.sopt.on = bool(msg.get("on"))
            await self.say("boss", "system", "Stock options ON: PMs may express daily signals with defined-risk spreads." if self.sopt.on
                           else "Stock options OFF: PMs trade shares only. Open spreads run to their exits.")
        elif kind == "experiment_now":
            self.trials.next_at = 0
            await self.trials.maybe_run()
        elif kind == "read_now":
            await self.library.read_now(msg.get("agent") or None)
        elif kind == "reflect_now":
            await self.minds.maybe_reflect(force=True)
        elif kind == "letter_now":
            if not self.writing_letter:
                asyncio.create_task(self.write_letter())
        elif kind == "fire" and a in self.ids():
            agent = next(x for x in self.roster if x["id"] == a)
            if agent.get("founder"):
                return
            self.experiment.change(f"Team: fired {agent['name']}")
            await self.lab.fire(agent, "The CIO made the call.")
        else:
            return
        self.save()
        await self.push()

    def ids(self):
        return [a["id"] for a in self.roster]

    def inactive(self):
        return self.benched | set(self.stopped)

    def reallocate(self, announce=True):
        old = self.alloc
        self.alloc, self.dup = allocate(self.roster, {a["id"]: self.score.stats(a["id"]) for a in self.roster}, self.inactive(),
                                        self.overlap.report)
        changed = any(abs(self.alloc.get(i, 0) - old.get(i, 0)) > 0.05 for i in self.alloc)
        return announce and changed

    def bars_json(self, sym, n=200):
        df = self.desk.bars.get(sym)
        if df is None:
            df = self.desk.daily.get(sym)
        if df is None:
            return []
        d = df.iloc[-n:]
        return [[int(t.timestamp()), round(float(r.Open), 6), round(float(r.High), 6), round(float(r.Low), 6), round(float(r.Close), 6)]
                for t, r in zip(d.index, d.itertuples())]

    # ── plumbing ──
    def _load(self):
        try:
            with open(C.STATE_FILE) as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save(self):
        st = dict(broker=self.broker.to_state(), score=self.score.to_state(), curve=self.curve[-60000:], lab_tests=self.lab.n_tests(),
                  day_start=self.day_start, benched=sorted(self.benched), settings=self.settings,
                  roster=self.roster, research=self.lab.to_state(), stopped=self.stopped,
                  last_daily={k: str(v) for k, v in self.last_bar.items() if k.startswith(("d:", "h:"))},
                  pod_peak=self.pod_peak, pod_hist={k: v[-1500:] for k, v in self.pod_hist.items()}, games=self.games, letters=self.letters[-30:], alpaca=self.alpaca.to_state(), studio=self.studio.to_state(),
                  wire=self.board.to_state(), news=self.news.to_state(),
                  career=self.career.to_state(), gex=self.gex.to_state(),
                  study=self.study.to_state(), unlocks=self.unlocks.to_state(), minds=self.minds.to_state(),
                  trials=self.trials.to_state(), library=self.library.to_state(), overlap=self.overlap.to_state(), stockopts=self.sopt.to_state(),
                  toolbox=self.toolbox.to_state(), incubator=self.incubator.to_state(), arena=self.arena.to_state(),
                  builder=self.builder.to_state(), digest=self.digest.to_state(), cio=self.cio.to_state(),
                  mlab=self.mlab.to_state(), compliance=self.compliance.to_state(), riskrep=self.riskrep.to_state(),
                  fundops=self.fundops.to_state(), experiment=self.experiment.to_state())
        tmp = C.STATE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(st, f, default=str)
        os.replace(tmp, C.STATE_FILE)

    async def say(self, agent, kind, text, pause=0.0, **extra):
        await self.emit_cb(dict(kind=kind, agent=agent, name=self.names.get(agent, agent), text=text, t=time.time(), **extra))
        self.cityhall.note(agent, self.names.get(agent, agent), text)
        self.digest.note(kind, agent, self.names.get(agent, agent), text, extra)
        if pause:
            await asyncio.sleep(pause)

    async def push(self):
        await self.snapshot_cb(self.snapshot())

    def prices(self):
        return {s: self.desk.price(s) for s in C.INST if self.desk.price(s)}

    def snapshot(self) -> dict:
        px = self.prices()
        eq = self.broker.equity(px)
        start_eq = self.day_start.get(time.strftime("%Y-%m-%d"), eq)
        m = metrics(self.curve + [[int(time.time()), eq]], C.STARTING_CASH)
        ex = self.broker.exposure(px)
        pos = []
        for k, p in self.broker.positions.items():
            last = px.get(p["sym"], p["entry"])
            pos.append(dict(key=k, sym=p["sym"], pod=p["pod"], pod_name=self.names.get(p["pod"], p["pod"]), side=p["side"],
                            qty=p["qty"], entry=p["entry"], last=last, stop=p["stop"], upl=self.broker.upl(k, last),
                            pv=C.INST[p["sym"]]["pv"], group=group_of(p["sym"])))
        greeks = dict(delta=0.0, gamma=0.0, vega=0.0, theta=0.0)
        for k, stx in self.broker.opt.items():
            val, upl = self.broker.opt_value(k), self.broker.opt_upl(k)
            legs, sdelta = [], 0.0
            for l in stx["legs"]:
                if l["name"] in self.chain.opts:
                    g, S = self.chain.greeks(l["name"]), self.chain.opts[l["name"]]["S"]
                    sdelta += l["side"] * l["qty"] * g["delta"] * S
                    greeks["delta"] += l["side"] * l["qty"] * g["delta"] * S
                    greeks["gamma"] += l["side"] * l["qty"] * g["gamma"] * S * S / 100
                    greeks["vega"] += l["side"] * l["qty"] * g["vega"]
                    greeks["theta"] += l["side"] * l["qty"] * g["theta"]
                legs.append(dict(name=l["name"], side=l["side"], qty=l["qty"], entry=l["entry"],
                                 mark=self.broker.opt_marks.get(l["name"], l["entry"]), strike=l.get("strike"), kind=l.get("kind"),
                                 iv=(self.chain.opts.get(l["name"]) or {}).get("iv") or l.get("iv")))
            exp = stx["legs"][0]["exp"]
            pos.append(dict(key=k, sym=f"{stx['cur']} {stx['kind']}", pod=stx["pod"], pod_name=self.names.get(stx["pod"], stx["pod"]),
                            side=0, qty=stx["legs"][0]["qty"], entry=stx["credit"], last=val, stop=-stx["max_loss"],
                            upl=upl - stx["fees"], option=True, legs=legs, dte=(exp - time.time()) / 86400, max_loss=stx["max_loss"],
                            under=stx["cur"], group=group_of(stx["cur"]), venue=stx.get("venue", "deribit"), exp=exp,
                            spot=self.chain.index.get(stx["cur"]) or px.get(stx["cur"]), kind=stx["kind"], fees=stx["fees"],
                            delta_usd=sdelta if stx.get("venue") != "alpaca" else stx.get("dir", 1) * 0.30 * OPT_MULT * stx["legs"][0]["qty"] * px.get(stx["cur"], stx.get("opened_px", 0))))
        pods = []
        for a in self.roster:
            i = a["id"]
            status = "stopped" if i in self.stopped else "paused" if i in self.benched else "active"
            pnl = self.broker.pod_pnl(i, px)
            pods.append(dict(id=i, name=a["name"], family=a["family"], desc=a.get("desc", ""), founder=a.get("founder", False),
                             slot=a.get("slot"), markets=a.get("markets"), tf=a.get("tf", "15m"), idea=a.get("idea"), bt=a.get("bt"), hired=a.get("hired"), mentor=a.get("mentor"),
                             color=a.get("color", 0), stats=self.score.stats(i), alloc=self.alloc.get(i, 0.0), capital=eq * self.alloc.get(i, 0.0),
                             dup=self.dup.get(i), risk=self.pod_risk(i), pnl=pnl, status=status, stop_reason=self.stopped.get(i), positions=sum(1 for p in pos if p["pod"] == i),
                             trades=sum(1 for t in self.broker.trades if t.get("pod") == i), hist=self.pod_hist.get(i, [])[-336:]))
        snap = dict(
            fund=C.FUND_NAME, equity=eq, cash=self.broker.cash, start=C.STARTING_CASH, day_pnl=eq - start_eq,
            day_ret=(eq / start_eq - 1) if start_eq else 0.0, nav=m["nav"], sharpe=m["sharpe"], vol=m["vol"], maxdd=m["maxdd"],
            gross=ex["gross"], net=ex["net"], by_cls=ex["by_cls"],
            margin=dict(borrowed=max(0.0, -self.broker.cash), interest_paid=self.broker.interest_paid, rate=C.MARGIN_RATE,
                        max_gross=C.MAX_GROSS, long_notional=self.broker.cash_notional(px)),
            open_risk=self.broker.open_risk(), fees=self.broker.fees_paid, positions=pos,
            trades=self.broker.trades[-40:], curve=self.curve[-1500:],
            markets=self.desk.market_rows(),
            agents={a["id"]: self.score.stats(a["id"]) for a in self.roster} | {"ava": self.score.stats("ava")},
            roster=pods, research=self.lab.snapshot(), headline=self.headline, letters=self.letters[-10:],
            writing_letter=self.writing_letter, analyst_on=self.brain.enabled, brain=self.brain.mode,
            broker_link=self.alpaca.snapshot(), studio=self.studio.snapshot(), wire=self.board.snapshot(), news=self.news.snapshot(), career=self.career.snapshot(), gex=self.gex.snapshot(), study=self.study.snapshot(), unlocks=self.unlocks.progress(),
            greeks=greeks, optvol=self.vol, feeds=self.desk.feeds(), chain_ok=self.chain.error is None and bool(self.chain.opts),
            vic=dict(self.vic_regime), ts=time.time(), benched=sorted(self.benched),
            settings={k: getattr(C, k) for k in self.LIMITS},
        )
        snap["minds"] = self.minds.snapshot()
        snap["trials"] = self.trials.snapshot()
        snap["library"] = self.library.snapshot()
        snap["overlap"] = self.overlap.snapshot()
        snap["riskbook"] = self.riskbook.snapshot(px, eq)
        snap["toolbox"] = self.toolbox.snapshot()
        snap["incubator"] = self.incubator.snapshot()
        snap["ops"] = self.ops.snapshot()
        snap["arena"] = self.arena.snapshot()
        snap["mydesk"] = self.mydesk.snapshot()
        snap["asks"] = self.askdesk.snapshot()
        snap["builder"] = self.builder.snapshot()
        snap["cio"] = self.cio.snapshot()
        snap["mlab"] = self.mlab.snapshot(compact=True)
        snap["voldesk"] = self.voldesk.snapshot()
        snap["compliance"] = self.compliance.snapshot()
        snap["riskrep"] = self.riskrep.snapshot()
        st_ = self.fundops.statement()
        snap["fundops"] = dict(statement={k: v for k, v in st_.items() if k not in ("strikes",)}, latest=(self.fundops.reports or [None])[-1],
                               n_reports=len(self.fundops.reports))
        try:
            snap["tear"] = tearsheet.build(self)
        except Exception as e:          # a reporting bug must never stop the floor
            snap["tear"] = dict(error=repr(e)[:160])
        snap["stockopts"] = self.sopt.snapshot()
        snap["city"] = self.cityhall.snapshot(snap)
        return snap

    # ── one loop of the floor ──
    async def step(self):
        if self.busy:
            return
        self.busy = True
        try:
            await self.desk.refresh()
            if not self.desk.errors:
                self.ops.fresh("market data")
            await self.desk.refresh_rt()
            if self.desk.rt_ok:
                self.ops.fresh("Alpaca quotes")
            if await self.desk.refresh_daily():
                self.ops.fresh("daily bars")
                await self.say("dot", "data", f"Daily bars refreshed for {len(self.desk.daily)} markets.", pause=1)
            if not self.hdesk.loading and time.time() - self.hdesk.last > 300:
                asyncio.create_task(self._refresh_hourly())
            for e in self.desk.errors:
                await self.say("dot", "chatter", f"Data hiccup: {e[:60]}")
            if self.desk.live:
                movers = sorted(self.desk.live.items(), key=lambda kv: -abs(kv[1]["chg_bar"]))[:2]
                txt = ", ".join(f"{s} {fmt(v['px'])} ({v['chg_24h']:+.1%})" for s, v in movers)
                await self.say("dot", "data", f"Market data refreshed. {txt}", pause=1.5)

            self.broker.accrue_interest(C.MARGIN_RATE)
            await self.manage_positions()
            await self.sopt.manage()
            await self.options_desk()
            if self.chain.opts and not self.chain.error:
                self.ops.fresh("Deribit options")
            await self.gex.step()
            await self.cro_check()
            if time.time() - self.last_pod_hist > 1800:
                self.last_pod_hist = time.time()
                px_h = self.prices()
                for a in self.roster:
                    self.pod_hist.setdefault(a["id"], []).append([int(time.time()), round(self.broker.pod_pnl(a["id"], px_h), 2)])
            if self.alpaca.enabled and time.time() - self.alpaca.last_sync > C.ALPACA_SYNC_SEC:
                msgs = await self.alpaca.sync(self.broker.positions, self.broker.equity(self.prices()), self.prices(), self.desk.is_open)
                if not self.alpaca.error:
                    self.ops.fresh("Alpaca broker")
                for m in msgs:
                    await self.say("eddie", "risk" if ("KILL" in m or "reject" in m or "Blocked" in m or "refused" in m) else "order", m,
                                   pause=1.0, ok=not ("KILL" in m or "reject" in m))

            for inst in C.INSTRUMENTS:
                s = inst["sym"]
                df = self.desk.bars.get(s)
                if df is None or len(df) < 120 or not self.desk.status.get(s):
                    continue
                t = df.index[-1]
                if self.last_bar.get(s) == t:
                    continue
                self.last_bar[s] = t
                await self.think(inst, df)

            for inst in C.INSTRUMENTS:                    # the daily book: every market, once per completed day
                s = inst["sym"]
                df = self.desk.daily.get(s)
                if df is None or len(df) < 120:
                    continue
                t = str(df.index[-1].date())
                if self.last_bar.get("d:" + s) == t or not self.desk.is_open(s):   # act when the market opens (next-open fill)
                    continue
                self.last_bar["d:" + s] = t
                await self.think(inst, df, tf="1d")

            for s, df in list(self.hdesk.bars.items()):     # the hourly book: once per completed hour, when the market is open
                if s not in C.INST or df is None or len(df) < 150:
                    continue
                t = str(df.index[-1])
                if self.last_bar.get("h:" + s) == t or not self.desk.is_open(s):
                    continue
                self.last_bar["h:" + s] = t
                await self.think(C.INST[s], df, tf="1h")

            graded = self.score.evaluate(self.desk.bars, self.desk.daily, self.hdesk.bars)
            for g in graded:
                st = self.score.stats(g["agent"])
                await self.say("sam", "score",
                               f"{self.names.get(g['agent'], g['agent'])}'s {g['sym']} call was {'RIGHT' if g['ret'] > 0 else 'WRONG'} "
                               f"({g['ret']:+.2%}). Hit rate {st['hit']:.0%}, trust {st['trust']:.2f}",
                               pause=1.0, target=g["agent"], ok=g["ret"] > 0)
            if graded:
                await self.lab.review()
                if self.reallocate() and time.time() - self.last_realloc_msg > 3600:
                    self.last_realloc_msg = time.time()
                    top = sorted(((self.names[i], w) for i, w in self.alloc.items() if w > 0), key=lambda x: -x[1])
                    await self.say("boss", "system", "Reallocating capital: " + ", ".join(f"{n} {w:.0%}" for n, w in top), pause=2)

            if self.brain.enabled and "ava" not in self.benched and time.time() - self.last_analysis > C.ANALYST_EVERY_MIN * 60 \
                    and not self.lab.running:
                self.last_analysis = time.time()
                asyncio.create_task(self.run_analyst())
            await self.lab.maybe_run()
            if not self.lab.running:
                await self.minds.maybe_reflect()
                await self.trials.maybe_run()
                await self.library.step()
                await self.overlap.step()
                await self.toolbox.step()
                await self.incubator.step()
            await self.mlab.step()
            await self.voldesk.step()
            await self.compliance.step()
            await self.riskrep.step()
            await self.fundops.step()
            await self.studio.maybe_run()
            await self.news.step()
            await self.career.step()
            await self.study.step()
            await self.unlocks.check()
            await self.ops.check()
            await self.cio.tick()
            await self.arena.grade()
            if self.board.inbox("fund") and not self.answering:
                asyncio.create_task(self.answer_inbox())
            if time.time() - self.last_huddle > C.HUDDLE_EVERY_MIN * 60 and not self.lab.running:
                self.last_huddle = time.time()
                await self.huddle()
            last_letter = self.letters[-1]["t"] if self.letters else 0
            if self.brain.enabled and not self.writing_letter and not self.lab.running and len(self.curve) > 30 \
                    and time.time() - last_letter > C.LETTER_EVERY_H * 3600:
                asyncio.create_task(self.write_letter())

            eq = self.broker.equity(self.prices())
            self.day_start.setdefault(time.strftime("%Y-%m-%d"), eq)
            self.curve.append([int(time.time()), round(eq, 2)])
            if len(self.curve) > 70000:
                del self.curve[:-60000]
            self.cityhall.last_step = time.time()
            self.save()
            await self.push()
        finally:
            self.busy = False

    async def _refresh_hourly(self):
        first = await self.hdesk.refresh()
        if first:
            await self.say("dot", "data", f"Hourly history loaded: {len(self.hdesk.bars)} markets, back to "
                           f"{min(df.index[0] for df in self.hdesk.bars.values()).year}. 1-hour PMs can trade now.", pause=1)

    # ── each pod trades its own book ──
    async def think(self, inst, df, tf="15m"):
        s = inst["sym"]
        ind = indicators(df)
        px = ind["close"]
        rank = ind["atr_pct_rank"]
        regime = "storm" if rank > 0.8 else "calm" if rank < 0.2 else "normal"
        if tf == "15m" and regime != self.vic_regime.get(s):
            msgs = {"storm": f"{s} volatility is spiking. Pods trade half size.",
                    "calm": f"{s} is quiet. Low volatility.", "normal": f"{s} volatility back to normal."}
            if s in self.vic_regime or regime != "normal":
                await self.say("vic", "vol", msgs[regime], pause=1.0, sym=s, regime=regime)
            self.vic_regime[s] = regime

        any_call = False
        for a in self.roster:
            pod = a["id"]
            if a["family"] == "options" or pod in self.inactive() or (a.get("markets") and s not in a["markets"]) \
                    or a.get("tf", "15m") != tf:
                continue
            try:
                d, info = live_call(df, a["family"], dict(a["params"], _sym=s) if a["family"] == "model" else a["params"])
            except Exception:
                continue
            if not d:
                continue
            any_call = True
            if tf in ("1d", "1h"):
                px = self.desk.price(s) or px
            self.score.record(pod, s, d, px, ind["t"], tf)
            key = pos_key(pod, s)
            pos = self.broker.positions.get(key)
            if tf == "1d" and optionable(s):
                await self.sopt.flip(pod, s, d)
                if self.sopt.has(pod, s):
                    continue
            if pos and pos["side"] == d:
                continue
            if a["family"] == "breakout":
                why = f"{s} {'breakout' if d > 0 else 'breakdown'} at {fmt(px)}."
            elif a["family"] == "meanrev":
                why = f"{s} stretched (z={info.get('z', 0):+.1f}), expecting a snap back."
            elif a["family"] == "custom":
                why = f"{s}: my own setup fired ({a.get('desc', '')[:90]})."
            else:
                why = f"{s} momentum {info.get('ret', 0):+.1%} over {a['params']['lookback']} {'days' if tf == '1d' else 'bars'}."
            if tf == "1d":
                why = "[daily] " + why
            elif tf == "1h":
                why = "[1h] " + why
            if pos:  # signal reversed: the pod exits
                await self.say(pod, "signal", f"{why} Exiting my {s} {'long' if pos['side'] > 0 else 'short'}.", pause=3.0, sym=s, dir=d)
                await self.exit(key, px, "signal reversed")
                continue
            if d < 0 and not inst["shorts"]:
                continue
            await self.say(pod, "signal", f"{why} I want to {'BUY' if d > 0 else 'SELL'}.", pause=3.5, sym=s, dir=d)
            v = self.views.get(s)
            overlay, cio_why, verdict = self.cio.review(a, inst, d, bool(v and time.time() - v["t"] < 3600 and v["bias"] * d <= -0.5))
            if verdict == "PASS":
                self.cio.log(pod, s, d, overlay, cio_why, verdict)
                await self.say("boss", "decision", f"{a['name']}: PASS on {s}. {'; '.join(cio_why).capitalize()}.", pause=2.5, sym=s, dir=d, verdict="PASS")
                continue
            size_txt = "full size" if abs(overlay - 1) < 0.05 else f"{overlay:.2g}x size"
            await self.say("boss", "decision", f"{a['name']}: approved at {size_txt}" + (f" ({'; '.join(cio_why)})" if cio_why else ", clean fit with the book")
                           + ". Rex, size it.", pause=2.5, sym=s, act="trade", dir=d, mult=round(overlay, 2))
            okc, cwhy = self.compliance.check(pod, s, d)
            if not okc:
                self.cio.log(pod, s, d, 0.0, [f"compliance: {cwhy}"], "PASS")
                await self.say("lena", "compliance", f"BLOCKED: {a['name']}'s {s}. {cwhy[0].upper() + cwhy[1:]}.", pause=2, sym=s, ok=False, target=pod)
                continue
            if cwhy:
                await self.say("lena", "compliance", f"Flag on {a['name']}'s {s}: {cwhy}.", pause=1, sym=s, target=pod)
            ok, qty, stop, reason = self.size(inst, pod, d, px, ind["atr"], regime, a["params"]["stop_atr"], overlay)
            if not ok:
                await self.say("rex", "risk", f"VETO on {a['name']}'s {s}: {reason}", pause=2.5, sym=s, ok=False, target=pod)
                continue
            expr = "shares"
            if tf == "1d" and optionable(s) and self.sopt.on and self.sopt.configured:
                expr, how = self.sopt.choose(pod)
                if expr == "spread":
                    await self.say(pod, "signal", f"I'll trade it with a {'call' if d > 0 else 'put'} spread: capped risk"
                                   + (" (still testing spreads vs shares)." if how == "exploring" else ", since spreads have worked better for me."), pause=2.5, sym=s, dir=d)
                    done, why_not = await self.sopt.open(a, inst, d, px, ind["atr"], reason, stop)
                    if done:
                        self.cio.log(pod, s, d, overlay, cio_why, "APPROVED")
                        self.sopt.turn[pod] = "spread"
                        continue
                    await self.say("rex", "risk", f"No spread for {a['name']} on {s} ({why_not}). Shares instead.", pause=2, sym=s, target=pod)
                    expr = "shares"
                self.sopt.turn[pod] = "shares"
            await self.say("rex", "risk", f"APPROVED: {qty:g} {s} for {a['name']}, stop {fmt(stop)}. Risk ${reason:,.0f}.{self.size_note}", pause=2.5, sym=s, ok=True, target=pod)
            await self.say("eddie", "order", f"Working {a['name']}'s order: {'buy' if d > 0 else 'sell'} {qty:g} {s}...", pause=3.5, sym=s, dir=d)
            key, fill, f = self.broker.open(pod, s, d, qty, px, stop, a["name"])
            self.cio.log(pod, s, d, overlay, cio_why, "APPROVED", key)
            self.broker.positions[key].update(trail_atr=a["params"]["trail_atr"], max_bars=a["params"]["max_bars"], tf=tf,
                                              risk0=float(reason), expr=expr if tf == "1d" and optionable(s) else None)
            await self.say("eddie", "fill", f"FILLED {qty:g} {s} @ {fmt(fill)} for {a['name']} (fees ${f:,.2f})", pause=1.0, sym=s)
        if tf == "15m" and not any_call and random.random() < 0.08 and self.roster:
            await self.say(random.choice(self.roster)["id"], "chatter", f"No setup on {s} this bar.")

    # ── Rex (CRO): sizing within pod and fund limits ──
    def size(self, inst, pod, side, px, atr, regime, stop_atr, overlay=1.0, risk_cash=None):
        eq = self.broker.equity(self.prices())
        if len(self.broker.positions) + len(self.sopt.mine()) >= C.MAX_POSITIONS:
            return False, 0, 0, f"fund already has {C.MAX_POSITIONS} positions"
        if risk_cash is None:                      # a PM: risk comes from its capital and the CIO's dial (Jason's desk passes its own)
            cap = eq * self.alloc.get(pod, 0.0)
            if cap <= 0:
                return False, 0, 0, "pod has no capital allocated"
            risk_cash = min(cap * self.pod_risk(pod) * (0.5 if regime == "storm" else 1.0) * overlay, cap * C.MAX_POD_RISK)
        stop_dist = stop_atr * atr
        stop = px - side * stop_dist
        budget = eq * C.MAX_TOTAL_RISK - self.broker.open_risk()
        if budget <= 0:
            return False, 0, 0, f"fund risk budget ({C.MAX_TOTAL_RISK:.0%}) is full"
        qty = min(risk_cash, budget) / (stop_dist * inst["pv"])
        bound = "the fund risk budget" if budget < risk_cash else ""
        if inst["cls"] == "futures":
            room = C.MAX_FUT_LEVERAGE * eq - self.broker.futures_notional(self.prices())
            if room / (px * inst["pv"]) < qty:
                qty, bound = room / (px * inst["pv"]), f"the {C.MAX_FUT_LEVERAGE:.0%} futures leverage cap"
        else:
            buying_power = min(C.MAX_GROSS * eq - self.broker.cash_notional(self.prices()),   # 1.0x = cash only, up to 2.0x on margin
                               self.broker.cash + (C.MAX_GROSS - 1) * eq)                     # (never borrow at 1.0x, even with futures gains)
            for lim, why in ((C.MAX_POS_NOTIONAL * eq / px, f"the {C.MAX_POS_NOTIONAL:.0%}-of-NAV position cap"),
                             (max(0.0, buying_power) * 0.98 / px, f"buying power (${max(0.0, buying_power):,.0f} left at {C.MAX_GROSS:.2g}x gross)")):
                if lim < qty:
                    qty, bound = lim, why
        room, crowd = self.riskbook.room(inst, side, px, eq, self.prices())     # what the whole fund can still add here
        want = qty_round(qty, inst["step"])
        qty = qty_round(min(qty, room / (px * inst["pv"])), inst["step"])
        self.size_note = (f" Cut from {want:g} to fit the fund limit: {crowd}." if 0 < qty < want
                          else f" Size limited by {bound}." if bound and qty >= inst["step"] else "")
        if qty < inst["step"]:
            return False, 0, 0, ("crowded trade: " + crowd) if want >= inst["step"] else "too small to trade at this risk size"
        return True, qty, stop, qty * stop_dist * inst["pv"]

    def pod_risk(self, pod):
        """Risk per trade as a share of the pod's capital: the CIO's dial from the Quant Toolbox (Monte Carlo, robustness,
        crisis tests), or the starting risk for pods without evidence. A pod halfway to its drawdown stop trades half
        size, three quarters of the way: a quarter (the pod-shop way to cut risk before the stop, not at it)."""
        d = self.toolbox.dials.get(pod)
        r = min(d["risk"], C.MAX_POD_RISK) if d else C.RISK_PER_TRADE
        px = self.prices()
        cap = self.broker.equity(px) * max(self.alloc.get(pod, 0.0), C.MIN_ALLOC)
        pnl = self.broker.pod_pnl(pod, px)
        used = (self.pod_peak.get(pod, pnl) - pnl) / max(C.POD_DD_LIMIT * cap, 1e-9)
        return r * (0.25 if used >= 0.75 else 0.5 if used >= 0.5 else 1.0)

    async def cro_check(self):
        """Pod-shop rule: a pod that falls POD_DD_LIMIT of its capital below its best P&L is shut down.
        Then the fund-wide risk book: no market or market group over its limit across all pods."""
        await self.riskbook.enforce()
        px = self.prices()
        eq = self.broker.equity(px)
        for a in self.roster:
            i = a["id"]
            if i in self.inactive():
                continue
            pnl = self.broker.pod_pnl(i, px)
            self.pod_peak[i] = max(self.pod_peak.get(i, pnl), pnl)
            cap = eq * max(self.alloc.get(i, 0.0), C.MIN_ALLOC)
            if self.pod_peak[i] - pnl > C.POD_DD_LIMIT * cap:
                self.stopped[i] = f"hit the {C.POD_DD_LIMIT:.0%} drawdown limit"
                await self.say("rex", "risk", f"{a['name']}'s pod is down {(self.pod_peak[i] - pnl):,.0f} from its peak. Shutting it down.", pause=2, ok=False)
                for k in [k for k, p in self.broker.positions.items() if p["pod"] == i]:
                    px_k = self.desk.price(self.broker.positions[k]["sym"])
                    if px_k:
                        await self.exit(k, px_k, "pod stopped out")
                for k in [k for k, stx in self.broker.opt.items() if stx["pod"] == i]:
                    await self.close_structure(k, "pod stopped out")
                await self.say("boss", "system", f"{a['name']}, you're off the desk until the lab clears you. That's the rule.", pause=2)
                self.reallocate()

    # ── Eddie: stops, trailing stops, time stops ──
    async def manage_positions(self):
        for key in list(self.broker.positions):
            p = self.broker.positions[key]
            s = p["sym"]
            daily, hourly = p.get("tf") == "1d", p.get("tf") == "1h"
            df = self.desk.daily.get(s) if daily else self.hdesk.bars.get(s) if hourly else self.desk.bars.get(s)
            px = self.desk.price(s)
            if px is None or df is None or not self.desk.is_open(s):
                continue
            live = dict(px=px)
            atr = indicators(df)["atr"]
            if daily:
                if p.get("last_day") != str(df.index[-1].date()):
                    p["last_day"] = str(df.index[-1].date())
                    p["bars"] = p.get("bars", 0) + 1
            elif hourly:
                if p.get("last_h") != str(df.index[-1]):
                    p["last_h"] = str(df.index[-1])
                    p["bars"] = p.get("bars", 0) + 1
            elif self.last_bar.get(s) != df.index[-1]:
                p["bars"] = p.get("bars", 0) + 1
            name = self.names.get(p["pod"], p["pod"])
            if p.get("close_at_open"):
                await self.exit(key, live["px"], "Jason closed it")
                continue
            if (live["px"] - p["stop"]) * p["side"] <= 0:  # live price (bar high/low may predate entry)
                await self.say("eddie", "trail", f"Stop hit on {name}'s {s}. Closing.", pause=1.5, sym=s)
                await self.exit(key, p["stop"], "stop hit")
                continue
            if p["bars"] > p.get("max_bars", C.TIME_STOP_BARS):
                await self.exit(key, live["px"], "time stop")
                continue
            p["best"] = max(p["best"], live["px"]) if p["side"] > 0 else min(p["best"], live["px"])
            new_stop = p["best"] - p["side"] * p.get("trail_atr", C.TRAIL_ATR) * atr
            if (new_stop - p["stop"]) * p["side"] > 0.25 * atr:
                p["stop"] = new_stop
                await self.say("eddie", "trail", f"Trailing {name}'s {s} stop to {fmt(new_stop)}", sym=s)

    async def exit(self, key, px, reason):
        p = self.broker.positions[key]
        name = self.names.get(p["pod"], p["pod"])
        await self.say("eddie", "order", f"Closing {name}'s {p['sym']} ({reason})...", pause=3.0, sym=p["sym"], dir=0)
        if key not in self.broker.positions:          # closed by someone else during the pause (fired, stopped out)
            return
        risk0, expr = p.get("risk0"), p.get("expr")
        tr = self.broker.close(key, px, reason)
        tr["tf"] = p.get("tf", "15m")
        if risk0:     # R-multiple + stop size: live evidence for the CIO's Monte Carlo risk dial
            tr["r"] = tr["pnl"] / risk0
            tr["sf"] = risk0 / (p["qty"] * p["entry"] * C.INST[p["sym"]]["pv"])
        if expr == "shares" and risk0:
            self.sopt.record(p["pod"], "shares", tr["pnl"] / risk0)
        self.cio.on_close(key, tr)
        if p["pod"] != MY_POD:                        # Jason's trades are his own; they don't train the AI
            await self.minds.on_trade(tr)
        await self.say("eddie", "close", f"CLOSED {name}'s {tr['sym']}: {'+' if tr['pnl'] >= 0 else '-'}${abs(tr['pnl']):,.2f}",
                       pause=1.0, sym=tr["sym"], pnl=tr["pnl"], pod=tr["pod"])

    async def trim(self, key, qty, px, reason):
        """Rex cuts part of a position (fund-wide risk limit). Not the PM's call, so it doesn't feed their learning."""
        p = self.broker.positions.get(key)
        if not p:
            return
        name = self.names.get(p["pod"], p["pod"])
        await self.say("eddie", "order", f"Trimming {name}'s {p['sym']} by {min(qty, p['qty']):g} ({reason})...", pause=2.0, sym=p["sym"], dir=0)
        if key not in self.broker.positions:
            return
        if qty >= p["qty"] - 1e-12:                  # all of it: still Rex's call, so it doesn't feed the PM's learning
            tr = self.broker.close(key, px, reason)
            tr.update(tf=p.get("tf", "15m"), trim=True)
            await self.say("eddie", "close", f"CLOSED {name}'s {tr['sym']} (risk limit): {'+' if tr['pnl'] >= 0 else '-'}${abs(tr['pnl']):,.2f}",
                           pause=1.0, sym=tr["sym"], pnl=tr["pnl"], pod=tr["pod"])
            return
        tr = self.broker.reduce(key, qty, px, reason)
        tr.update(tf=p.get("tf", "15m"), trim=True)
        await self.say("eddie", "close", f"TRIMMED {name}'s {tr['sym']} to {self.broker.positions[key]['qty']:g}: {'+' if tr['pnl'] >= 0 else '-'}${abs(tr['pnl']):,.2f} on the part sold",
                       pause=1.0, sym=tr["sym"], pnl=tr["pnl"], pod=tr["pod"])

    # ── Opal: the options desk ──
    async def options_desk(self):
        await self.chain.refresh()
        if self.chain.error:
            if random.random() < 0.2:
                await self.say("dot", "chatter", f"Deribit feed hiccup: {self.chain.error}")
            return
        for stx in self.broker.opt.values():
            for l in stx["legs"]:
                o = self.chain.opts.get(l["name"])
                if o:
                    self.broker.opt_marks[l["name"]] = o["mark"]
        for cur in OPT.CURRENCIES:   # vol dashboard: implied vs realized
            exp = self.chain.pick_expiry(cur)
            df = self.desk.bars.get(cur)
            iv = self.chain.atm_iv(cur, exp) if exp else None
            rv = OPT.realized_vol(df) if df is not None else None
            self.vol[cur] = dict(S=self.chain.index.get(cur), iv=iv, rv=rv, vrp=(iv / rv) if iv and rv else None,
                                 dte=(exp - time.time()) / 86400 if exp else None)
        for k in list(self.broker.opt):   # manage open structures
            stx = self.broker.opt[k]
            if stx.get("venue") == "alpaca":
                continue
            dte = (stx["legs"][0]["exp"] - time.time()) / 86400
            upl = self.broker.opt_upl(k)
            if stx["kind"] == "iron condor":
                if upl >= OPT.TAKE_PROFIT_CONDOR * stx["credit"]:
                    await self.close_structure(k, "took 50% of max profit")
                elif -upl >= OPT.STOP_CONDOR * stx["credit"]:
                    await self.close_structure(k, "condor stop")
                elif dte <= OPT.CLOSE_DTE:
                    await self.close_structure(k, "closing before expiry")
            else:
                paid = -stx["credit"]
                if upl >= OPT.TAKE_PROFIT_LONG * paid:
                    await self.close_structure(k, "option doubled")
                elif -upl >= OPT.STOP_LONG * paid:
                    await self.close_structure(k, "option stop (-50%)")
                elif dte <= OPT.CLOSE_DTE + 1:
                    await self.close_structure(k, "closing before expiry")
        if "opal" in self.inactive():
            return
        for cur in OPT.CURRENCIES:   # new trades: once per new 15-minute bar per coin
            df = self.desk.bars.get(cur)
            if df is None or len(df) < 120 or self.vol.get(cur, {}).get("vrp") is None:
                continue
            if self._opal_bar.get(cur) == df.index[-1]:
                continue
            self._opal_bar[cur] = df.index[-1]
            if any(stx["cur"] == cur for stx in self.broker.opt.values()):
                continue
            v = self.vol[cur]
            mom = float(df["Close"].iloc[-1] / df["Close"].iloc[-97] - 1)
            rule = self.mlab.vol_rule(cur, v["iv"])
            if rule and rule.get("ratio"):
                v.update(fc=rule["fc"], model_ratio=rule["ratio"], tier=rule["tier"], k=rule["k"])
            sell = (rule["tier"] != "none" and rule.get("ratio") is not None and rule["ratio"] >= rule["k"]) if rule else v["vrp"] >= OPT.VRP_SELL
            if sell and self.vic_regime.get(cur, "normal") != "storm":
                await self.open_condor(cur, v)
            elif v["vrp"] <= OPT.VRP_BUY and abs(mom) > 0.015:
                await self.open_long(cur, v, 1 if mom > 0 else -1, mom)

    def _risk_cash(self):
        eq = self.broker.equity(self.prices())
        cap = eq * self.alloc.get("opal", 0.0)
        budget = eq * C.MAX_TOTAL_RISK - self.broker.open_risk()
        return max(0.0, min(cap * self.pod_risk("opal"), budget))

    async def open_condor(self, cur, v):
        ch, exp = self.chain, self.chain.pick_expiry(cur)
        names = dict(sc=ch.by_delta(cur, exp, "C", OPT.CONDOR_SHORT_DELTA), lc=ch.by_delta(cur, exp, "C", OPT.CONDOR_WING_DELTA),
                     sp=ch.by_delta(cur, exp, "P", OPT.CONDOR_SHORT_DELTA), lp=ch.by_delta(cur, exp, "P", OPT.CONDOR_WING_DELTA))
        if None in names.values() or len(set(names.values())) < 4:
            return
        o = {k: ch.opts[n] for k, n in names.items()}
        if not (o["lc"]["strike"] > o["sc"]["strike"] > ch.index[cur] > o["sp"]["strike"] > o["lp"]["strike"]):
            return
        credit = o["sc"]["bid"] - o["lc"]["ask"] + o["sp"]["bid"] - o["lp"]["ask"]
        width = max(o["lc"]["strike"] - o["sc"]["strike"], o["sp"]["strike"] - o["lp"]["strike"])
        max_loss_1 = width - credit
        if credit <= 0 or max_loss_1 <= 0:
            return
        await self.say("opal", "signal", f"{cur} options are rich: implied vol {v['iv']:.0%} vs realized {v['rv']:.0%} (ratio {v['vrp']:.2f}). "
                       f"I want to SELL an iron condor {o['sp']['strike']:,.0f}/{o['sc']['strike']:,.0f}.", pause=3.5, sym=cur, dir=0)
        await self.trade_structure(cur, "iron condor", [("sc", -1), ("lc", 1), ("sp", -1), ("lp", 1)], names, o, max_loss_1,
                                   f"credit ${credit:,.0f}/unit, max loss ${max_loss_1:,.0f}/unit")

    async def open_long(self, cur, v, d, mom):
        ch, exp = self.chain, self.chain.pick_expiry(cur)
        n = ch.atm(cur, exp, "C" if d > 0 else "P")
        if not n:
            return
        o = {"x": ch.opts[n]}
        await self.say("opal", "signal", f"{cur} options are cheap (IV {v['iv']:.0%} vs realized {v['rv']:.0%}) and momentum is {mom:+.1%}. "
                       f"Buying a {o['x']['strike']:,.0f} {'call' if d > 0 else 'put'}.", pause=3.5, sym=cur, dir=d)
        await self.trade_structure(cur, f"long {'call' if d > 0 else 'put'}", [("x", 1)], {"x": n}, o, o["x"]["ask"],
                                   f"premium ${o['x']['ask']:,.0f}/unit")

    async def trade_structure(self, cur, kind, spec, names, o, max_loss_1, detail):
        okc, cwhy = self.compliance.check("opal", cur, 0)
        if not okc:
            await self.say("lena", "compliance", f"BLOCKED: Opal's {cur} {kind}. {cwhy}.", pause=2, sym=cur, ok=False, target="opal")
            return
        if self.cio.paused():
            await self.say("boss", "decision", f"Opal: PASS on the {cur} {kind}. Jason paused new entries.", pause=2, sym=cur, verdict="PASS")
            return
        F = self.cio.fund()
        at = "" if abs(F["mult"] - 1) < 0.05 else f" at {F['mult']:.2g}x ({F['mode']} mode)"
        await self.say("boss", "decision", f"Opal: approved{at}. Defined risk only. Rex, size it.", pause=2.5, sym=cur, act="trade")
        self.cio.log("opal", cur, 0, F["mult"], [f"{F['mode']} mode"] if F["mode"] != "normal" else [], "APPROVED")
        risk = self._risk_cash() * F["mult"]
        step = OPT.MIN_QTY[cur]
        qty = round(int(risk / max_loss_1 / step) * step, 2)
        if qty < step:
            await self.say("rex", "risk", f"VETO on Opal's {cur} {kind}: one contract risks ${max_loss_1 * step:,.0f}, "
                           f"budget is ${risk:,.0f}.", pause=2.5, sym=cur, ok=False, target="opal")
            return
        await self.say("rex", "risk", f"APPROVED: {qty:g} x {cur} {kind} for Opal. Max loss ${max_loss_1 * qty:,.0f}.",
                       pause=2.5, sym=cur, ok=True, target="opal")
        await self.say("eddie", "order", f"Routing Opal's {cur} {kind} to Deribit ({len(spec)} legs)...", pause=3.5, sym=cur, dir=0)
        legs = []
        for leg, side in spec:
            x = o[leg]
            px = x["ask"] if side > 0 else x["bid"]
            legs.append(dict(name=names[leg], kind=x["kind"], strike=x["strike"], exp=x["exp"], side=side, qty=qty, px=px,
                             fee=OPT.fee(x, qty, px)))
            self.broker.opt_marks[names[leg]] = x["mark"]
        key, fees = self.broker.open_opt("opal", cur, legs, max_loss_1 * qty, kind)
        await self.say("eddie", "fill", f"FILLED Opal's {cur} {kind} x{qty:g}: {detail} (fees ${fees:,.2f})", pause=1.0, sym=cur)

    async def close_structure(self, key, reason):
        stx = self.broker.opt[key]
        if stx.get("venue") == "alpaca":
            return await self.sopt.close(key, reason)
        exits, fees, now = {}, 0.0, time.time()
        for l in stx["legs"]:
            o = self.chain.opts.get(l["name"])
            if l["exp"] <= now or not o:   # expired or missing: settle at intrinsic value
                S = self.chain.index.get(stx["cur"], l["strike"])
                exits[l["name"]] = max(0.0, (S - l["strike"]) if l["kind"] == "C" else (l["strike"] - S))
            else:
                px = (o["bid"] if l["side"] > 0 else o["ask"]) or o["mark"]
                exits[l["name"]] = px
                fees += OPT.fee(o, l["qty"], px)
        await self.say("eddie", "order", f"Closing Opal's {stx['cur']} {stx['kind']} ({reason})...", pause=3.0, sym=stx["cur"], dir=0)
        tr = self.broker.close_opt(key, exits, fees, reason)
        self.score.record_result(stx["pod"], tr["ret"])
        await self.minds.on_trade({**tr, "pod": stx["pod"]})
        await self.say("eddie", "close", f"CLOSED Opal's {tr['sym']}: {'+' if tr['pnl'] >= 0 else '-'}${abs(tr['pnl']):,.2f}",
                       pause=1.0, sym=stx["cur"], pnl=tr["pnl"], pod=stx["pod"])

    # ── team huddle at the holo table ──
    async def huddle(self):
        snap = self.snapshot()
        pods = sorted(snap["roster"], key=lambda p: -p["pnl"])
        best, worst = pods[0], pods[-1]
        await self.say("boss", "huddle", f"Huddle, everyone. NAV {snap['nav']:.2f}, today {snap['day_ret']:+.2%}. "
                       f"Best pod: {best['name']} ({best['pnl']:+,.0f}). Weakest: {worst['name']} ({worst['pnl']:+,.0f}).", pause=10)
        await self.say("rex", "meeting", f"Risk: {len(snap['positions'])} open positions, ${snap['open_risk']:,.0f} at risk "
                       f"({snap['open_risk'] / max(snap['equity'], 1):.1%} of NAV). Drawdown {snap['maxdd']:.1%}.", pause=5)
        v = ", ".join(f"{c} IV {x['iv']:.0%} vs RV {x['rv']:.0%}" for c, x in self.vol.items() if x.get("iv") and x.get("rv"))
        if v:
            await self.say("opal", "meeting", f"Vol check: {v}.", pause=4)
        if (g := self.gex.huddle_line()):
            await self.say("vic", "meeting", g, pause=4)
        last = self.lab.log[-1] if self.lab.log else None
        if last:
            verdict = "PASSED" if last["passed"] else "failed"
            await self.say("ava", "meeting", f'Research: last test was "{last["name"]}", it {verdict} ({last["reason"]}).', pause=5)
        else:
            await self.say("ava", "meeting", "Research: first lab session coming up.", pause=5)
        learned = [(aid, p["lessons"][-1]["text"]) for aid, p in self.minds.m.items() if p["lessons"] and aid in self.names]
        if learned:
            aid, text = random.choice(learned)
            await self.say(aid, "meeting", f"Something I learned: {text}", pause=4)
        if self.minds.pitches:
            await self.say("ava", "meeting", f"{len(self.minds.pitches)} team pitch(es) queued for the lab.", pause=3)
        if (vl := self.riskrep.line()):
            await self.say("rex", "meeting", "Risk report: " + vl, pause=4)
        if self.mlab.models:
            m = self.mlab.models[-1]
            await self.say("kai", "meeting", f"Model Lab: {self.mlab.n_tests} models tested. Latest, \"{m['name']}\", {'passed' if m['passed'] else 'failed'}"
                           f" (IC {m['ic']:+.3f}, t={m['ic_t']:.1f}).", pause=3)
        if self.compliance.restricted:
            await self.say("lena", "meeting", "Compliance: restricted list is " + ", ".join(x["sym"] for x in self.compliance.restricted) + ".", pause=2)
        active = [p for p in pods if p["status"] == "active"]
        await self.board.post("fund", "ava", "studio", "market_brief",
                              f"Fund brief: NAV {snap['nav']:.2f}, today {snap['day_ret']:+.2%}, best pod {best['name']}. "
                              f"Market view: {self.headline or 'no fresh view yet'}",
                              data=dict(nav=snap["nav"], day_ret=snap["day_ret"], headline=self.headline))
        await self.say("boss", "meeting", "Allocations stay earned: " + ", ".join(f"{p['name']} {p['alloc']:.0%}" for p in active)
                       + ". Back to work.", pause=4)

    # ── Ava's market report ──
    async def run_analyst(self):
        lines = []
        for inst in C.INSTRUMENTS:
            s = inst["sym"]
            df = self.desk.bars.get(s)
            if df is None or len(df) < 60:
                continue
            i = indicators(df)
            lines.append(f"{s} ({inst['name']}): price {fmt(i['close'])}, 1h {i['ret_1h']:+.2%}, 4h {i['ret_4h']:+.2%}, "
                         f"vs EMA50 {i['close'] / i['ema50'] - 1:+.2%}, z-score {i['z']:+.1f}, "
                         f"ATR {i['atr'] / i['close']:.2%} (vol rank {i['atr_pct_rank']:.0%}), "
                         f"{'market open' if self.desk.status.get(s) else 'market closed'}")
        if not lines:
            return
        await self.say("ava", "chatter", "Reading the tape... give me a minute.")
        try:
            news = self.news.brief_for("market")
            res = await asyncio.to_thread(self.brain.ask, VIEW_SYSTEM, "Snapshot (15-minute bars):\n" + "\n".join(lines)
                                          + (f"\n\nJB Newsroom briefing (real headlines, summarized):\n{news}" if news else ""), VIEW_SCHEMA)
        except LLMError as e:
            await self.say("ava", "chatter", f"Couldn't finish my market report: {e}")
            return
        self.headline = res.get("headline", "")
        await self.say("ava", "analysis", f"[{res.get('mood', 'mixed').upper()}] {self.headline}", pause=4.0)
        bars = self.desk.bars
        for v in res.get("views", []):
            s = v.get("sym")
            if s not in C.INST:
                continue
            b = max(-1.0, min(1.0, float(v.get("bias", 0))))
            self.views[s] = dict(bias=b, reason=v.get("reason", ""), t=time.time())
            if abs(b) >= 0.3 and s in bars and len(bars[s]):
                self.score.record("ava", s, 1 if b > 0 else -1, float(bars[s]["Close"].iloc[-1]), bars[s].index[-1])
        await self.push()

    # ── investor letter ──
    async def write_letter(self):
        self.writing_letter = True
        try:
            snap = self.snapshot()
            await self.say("boss", "chatter", "Drafting the investor letter. Nobody bother me.")
            pods = "\n".join(f"- {p['name']} ({p['desc']}): alloc {p['alloc']:.0%}, P&L ${p['pnl']:,.0f}, {p['trades']} trades, "
                             f"{p['stats']['n']} graded calls, status {p['status']}" for p in snap["roster"])
            research = "\n".join(f"- {'PASS' if e['passed'] else 'FAIL'} {e['name']}: {e['reason']}" for e in self.lab.log[-8:]) or "- none yet"
            sharpe_txt = f"{snap['sharpe']:.2f}" if snap.get("sharpe") is not None else "n/a (needs 24h of history)"
            prompt = (f"Fund: {C.FUND_NAME} (paper trading, started with ${C.STARTING_CASH:,.0f})\n"
                      f"NAV per unit: {snap['nav']:.2f} (started at 100). Today: {snap['day_ret']:+.2%}. Max drawdown: {snap['maxdd']:.1%}. "
                      f"Sharpe: {sharpe_txt}. "
                      f"Gross exposure ${snap['gross']:,.0f}, net ${snap['net']:,.0f}. Fees paid ${snap['fees']:,.0f}.\n"
                      f"Pods:\n{pods}\nRecent research:\n{research}\nMarket view: {self.headline or 'none'}")
            try:
                res = await asyncio.to_thread(self.brain.ask, LETTER_SYSTEM, prompt, LETTER_SCHEMA)
            except LLMError as e:
                await self.say("boss", "chatter", f"Letter will have to wait: {e}")
                return
            self.letters.append(dict(t=time.time(), title=res.get("title", "Investor update")[:120], body=res.get("body", "")[:3000],
                                     nav=snap["nav"]))
            await self.say("boss", "letter", f"Investor letter sent: \"{self.letters[-1]['title']}\"", pause=2)
            await self.board.post("fund", "boss", "jason", "letter", f"New investor letter: {self.letters[-1]['title']}")
            self.save()
        finally:
            self.writing_letter = False
            await self.push()

    # ── The Wire: requests from Jason (dashboard or phone) ──
    async def jason_says(self, to, text):
        text = str(text).strip()[:600]
        if to not in BUILDINGS or to == "jason" or not text:
            raise ValueError("need a building (fund/studio) and some text")
        p = await self.board.post("jason", "jason", to, "request", text)
        if to == "studio":
            self.studio.next_at = min(self.studio.next_at, time.time() + 60)   # Iris picks it up at the next meeting, soon
            await self.say("rosa", "studio", "Founder request on the Wire. Iris, put it on the agenda.", phase="start")
        elif to == "news":
            if not self.news.answering:
                asyncio.create_task(self.news.answer_inbox())
        elif to == "study":
            if not self.study.answering:
                asyncio.create_task(self.study.answer_inbox())
        elif to == "career":
            if not self.career.answering:
                asyncio.create_task(self.career.answer_inbox())
        elif not self.answering:
            asyncio.create_task(self.answer_inbox())                          # the CIO answers right away
        self.save()
        await self.push()
        return p

    def status_text(self):
        s = self.snapshot()
        pods = ", ".join(f"{p['name']} {p['pnl']:+,.0f}" for p in sorted(s["roster"], key=lambda p: -p["pnl"]) if p["status"] == "active")
        st = s["studio"]
        return (f"JB Capital (paper): NAV {s['nav']:.2f}, equity ${s['equity']:,.0f}, today {s['day_ret']:+.2%}, max DD {s['maxdd']:.1%}, "
                f"{len(s['positions'])} open positions, ${s['open_risk']:,.0f} at risk. Pods: {pods or 'none active'}. "
                f"Market view: {s['headline'] or 'none yet'}. "
                f"Top news: {(s['news'].get('brief') or {}).get('headline', 'no briefing yet')}. "
                f"JB Ventures: {st['counts'].get('GREENLIT', 0)} greenlit, {st['counts'].get('WATCHLIST', 0)} watchlist, studio {st['status']}.")

    async def answer_inbox(self):
        """The CIO answers what reached the fund on the Wire (Jason's questions, other buildings' notes)."""
        self.answering = True
        try:
            for p in self.board.inbox("fund"):
                if p["topic"] == "request_fact":            # another tower needs the fund's numbers
                    await self.board.reply(p, "boss", self.status_text())
                    continue
                if p["topic"] == "news_flash":              # Rex checks the exposure; information only, never a trade
                    self.board.ack(p, "rex")
                    syms = set(p["data"].get("syms", []))
                    exp = [f"{x['sym']} {'long' if x['side'] > 0 else 'short'} (stop {fmt(x['stop'])})" for x in self.broker.positions.values() if x["sym"] in syms]
                    await self.say("rex", "chatter", f"Breaking news on {', '.join(sorted(syms))}. Our exposure: {'; '.join(exp) or 'none left'}. "
                                   "Stops stay where the plan put them: no trading on headlines.")
                    continue
                if p["topic"] == "news_brief":
                    self.board.ack(p, "ava")                  # Ava reads it in her next market report
                    continue
                if p["topic"] != "request":
                    await self.board.reply(p, "boss", "Noted. Thanks for the heads-up.")
                    continue
                await self.say("boss", "chatter", "Message from Jason on the Wire. Let me answer that.")
                ans = None
                if self.brain.enabled:
                    try:
                        res = await asyncio.to_thread(self.brain.ask, ANSWER_SYSTEM,
                                                      f"Fund status: {self.status_text()}\n\nJason asks: {p['text']}", ANSWER_SCHEMA)
                        ans = res.get("answer")
                    except LLMError as e:
                        ans = f"(My AI brain is unavailable: {e}.) Here's the status: {self.status_text()}"
                await self.board.reply(p, "boss", ans or self.status_text())
            self.save()
            await self.push()
        finally:
            self.answering = False
