"""Ask anyone on the floor: Jason walks up to an agent and asks a question; the agent answers in character from ITS
OWN live data (a PM: its pod, strategy, risk dial, positions, trades and lessons; Rex: the risk book; Ava: the lab and
the incubator; the CIO: the whole fund). With the LLM on, the answer is written in the agent's voice; with it off, the
agent reads out the relevant numbers. Answers appear as a speech bubble over the agent and in the feed."""
import asyncio
import time

from . import config as C
from .broker import pos_key
from .llm import LLMError
from .minds import PERSONAS

SYSTEM = ("You are {name}, {role} at JB Capital, an AI-run multi-strategy hedge fund that PAPER trades (simulated money at "
          "live prices). Personality: {traits}. Jason, the 18-year-old founder, walked up to you on the trading floor and "
          "asked you something. Answer in first person, in character, in at most 90 words, using ONLY the facts below (quote "
          "the real numbers); if the facts don't cover it, say you don't know. You can't place trades or change settings from "
          "a conversation. Be specific, honest and a little human. Reply only with the JSON.")
SCHEMA = {"type": "object", "properties": {"answer": {"type": "string", "description": "the reply, max 90 words"}},
          "required": ["answer"], "additionalProperties": False}
DAILY_MAX = 80


def usd(v):
    return f"{'-' if v < 0 else ''}${abs(v):,.0f}"


class AskDesk:
    def __init__(self, floor):
        self.f = floor
        self.busy = False
        self.day, self.n = None, 0
        self.log: list = []          # recent Q&A: {t, agent, q, a}

    def facts(self, aid) -> str:
        f = self.f
        px = f.prices()
        eq = f.broker.equity(px)
        lines = [f"Fund: equity {usd(eq)} (started {usd(C.STARTING_CASH)}), {len(f.broker.positions)} positions, "
                 f"{usd(f.broker.open_risk())} at risk if every stop hits."]
        pod = next((a for a in f.roster if a["id"] == aid), None)
        mind = f.minds.m.get(aid) or {}
        if pod:
            d = f.toolbox.dials.get(aid) or {}
            status = "benched" if aid in f.benched else f"stopped ({f.stopped[aid]})" if aid in f.stopped else "active"
            lines.append(f"Your pod: {status}, P&L {usd(f.broker.pod_pnl(aid, px))}, capital {f.alloc.get(aid, 0):.0%} of the fund, "
                         f"risk per trade {f.pod_risk(aid):.2%}" + (f" (CIO's Monte Carlo dial: {'; '.join(d.get('why', []))})" if d else "") + ".")
            lines.append(f"Your strategy: {pod.get('desc') or pod.get('family')} on {pod.get('tf', '15m')} bars; markets "
                         f"{', '.join(pod.get('markets') or []) or 'all'}. Backtest: {pod.get('bt', 'n/a')}.")
            mine = [p for p in f.broker.positions.values() if p["pod"] == aid]
            lines.append("Your open positions: " + ("; ".join(f"{p['sym']} {'long' if p['side'] > 0 else 'short'} {p['qty']:g} from {p['entry']:,.2f}, "
                                                              f"stop {p['stop']:,.2f}, P&L {usd(f.broker.upl(pos_key(p['pod'], p['sym']), px.get(p['sym'], p['entry'])))}"
                                                              for p in mine) or "none") + ".")
            tr = [t for t in f.broker.trades if t.get("pod") == aid][-5:]
            if tr:
                lines.append("Your last trades: " + "; ".join(f"{t['sym']} {usd(t['pnl'])} ({t.get('reason', '')})" for t in tr) + ".")
        elif aid == "rex":
            rb = f.riskbook.snapshot(px, eq)
            lines.append("Risk book (share of NAV, + long / - short): " + ", ".join(f"{s} {v:+.0%}" for s, v, _ in rb["syms"][:8])
                         + f". Caps: {rb['sym_cap']:.0%} per market, {rb['grp_cap']:.0%} per group. Groups: "
                         + ", ".join(f"{g} {v:+.0%}" for g, v, _ in rb["groups"][:6]) + ".")
            lines.append(f"Limits: {C.RISK_PER_TRADE:.1%} starting risk per trade, {C.MAX_TOTAL_RISK:.0%} total fund risk, pod drawdown stop "
                         f"{C.POD_DD_LIMIT:.0%}, max {C.MAX_POSITIONS} positions, {C.MAX_GROSS:.2g}x max gross. Stopped pods: "
                         + (", ".join(f"{f.names.get(k, k)} ({v})" for k, v in f.stopped.items()) or "none") + ".")
        elif aid == "ava":
            log = f.lab.log[-6:]
            lines.append(f"Research: {f.lab.n_tests()} ideas tested so far. Recent: " + "; ".join(
                f"{e.get('name')} {'PASSED' if e.get('passed') else 'failed'} ({e.get('reason', '')[:70]})" for e in log) + ".")
            inc = [x for x in f.incubator.items if x["status"] == "incubating"]
            lines.append(f"Incubator: {len(inc)} strategies paper-trading forward: " + ", ".join(x["name"] for x in inc[:6]) + ".")
            if f.headline:
                lines.append(f"Your current market view: {f.headline}")
        elif aid == "boss":
            lines.append(f.status_text())
            lines.append("Capital allocation: " + ", ".join(f"{f.names.get(k, k)} {w:.0%}" for k, w in sorted(f.alloc.items(), key=lambda x: -x[1]) if w > 0) + ".")
        elif aid == "eddie":
            tr = f.broker.trades[-6:]
            lines.append(f"Fees paid so far {usd(f.broker.fees_paid)}, margin interest {usd(f.broker.interest_paid)}. Recent closes: "
                         + "; ".join(f"{f.names.get(t['pod'], t['pod'])} {t['sym']} {usd(t['pnl'])}" for t in tr) + ".")
        elif aid == "vic":
            lines.append("Volatility regimes by market: " + (", ".join(f"{s} {r}" for s, r in f.vic_regime.items()) or "none flagged") + ".")
        elif aid in ("dot", "nova", "kip"):
            o = f.ops.snapshot()
            lines.append(f"Ops: feed ages in seconds {o.get('feeds')}, loop avg {o.get('loop_avg') or 'n/a'} s, errors {o.get('error_count')}, "
                         f"memory {o.get('rss_mb')} MB, uptime {o.get('uptime')}s.")
        elif aid == "juno":
            inc = f.incubator.snapshot()
            lines.append("Incubator: " + "; ".join(f"{x['name']} {x['status']} ({x.get('fwd', 0)} forward trades, {x['days']} days)" for x in inc["items"][:8]) + ".")
        elif aid == "sam":
            board = sorted(((a["name"], f.broker.pod_pnl(a["id"], px)) for a in f.roster), key=lambda x: -x[1])
            lines.append("Leaderboard by P&L: " + ", ".join(f"{n} {usd(v)}" for n, v in board) + ".")
        else:
            lines.append(f.status_text())
        pr = f.cio.active_priorities()
        if pr:
            lines.append("Jason's standing priorities for the floor: " + "; ".join(f'"{p["text"]}"' for p in pr) + ".")
        F = f.cio.fund()
        if aid in ("boss", "rex") or pod:
            lines.append(f"CIO risk mode: {F['mode']} (drawdown {F['dd']:.1%}), new trades size at {F['mult']:.2f}x"
                         + (f"; Jason's mandate: {F['mandate']['stance']}" if F['mandate'] else "") + (". New entries are PAUSED." if F["paused"] else "."))
        if pod and aid in f.cio.watch:
            lines.append(f"You are ON WATCH: {f.cio.watch[aid]['why']} (half size on new trades).")
        if mind.get("lessons"):
            lines.append("Your lessons so far: " + "; ".join(l["text"] for l in mind["lessons"][-3:]))
        if mind.get("goal"):
            lines.append(f"Your current goal: {mind['goal']}. Mood: {mind.get('mood', 'focused')}.")
        return "\n".join(lines)

    async def ask(self, aid, question):
        f = self.f
        q = " ".join(str(question).split())[:300]
        if not q or aid not in f.names or aid == "jason":
            return
        today = time.strftime("%Y-%m-%d")
        if self.day != today:
            self.day, self.n = today, 0
        name = f.names[aid]
        if self.busy:
            await f.say(aid, "chat", "One sec, Jason, still answering the last question.", pause=0.5, to="jason")
            return
        self.busy = True
        try:
            facts = self.facts(aid)
            ans = None
            if f.brain.enabled and self.n < DAILY_MAX:
                self.n += 1
                role, traits = PERSONAS.get(aid, ("PM", "focused professional"))
                if aid in f.minds.m:
                    role, traits = f.minds.m[aid].get("role", role), f.minds.m[aid].get("traits", traits)
                try:
                    res = await asyncio.to_thread(f.brain.ask, SYSTEM.format(name=name, role=role, traits=traits),
                                                  f"FACTS:\n{facts}\n\nJason asks: {q}", SCHEMA, 120)
                    ans = (res.get("answer") or "").strip()[:700] or None
                except LLMError:
                    ans = None
            if not ans:      # no AI brain (or the daily cap): read out the numbers
                mine = facts.split("\n", 1)[-1].replace("\n", " ").replace("Your ", "My ").replace(" your ", " my ")
                ans = ("My AI brain is off right now, so here are my numbers. " + mine)[:700]
            self.log = (self.log + [dict(t=time.time(), agent=aid, name=name, q=q, a=ans)])[-30:]
            await f.say(aid, "chat", ans, pause=0.5, to="jason", q=q)
        finally:
            self.busy = False

    def snapshot(self):
        return dict(busy=self.busy, log=self.log[-10:])

