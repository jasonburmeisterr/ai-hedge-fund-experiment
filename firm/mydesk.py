"""Jason's desk: the owner trades alongside the AI portfolio managers (paper, like everything else).

He picks the market, the direction, the stop (in daily ATRs), the risk (share of NAV) and how long to hold. Rex sizes
it under the same fund-wide limits as every PM (risk budget, buying power, crowding, max positions), Eddie fills it and
then manages it like any other position: hard stop, optional trailing stop, time stop. His trades show up in the books,
the tear sheet and the risk book like a real PM's would, but they never feed the AI's learning (no Monte Carlo dial,
no minds). A scoreboard compares his average R-multiple (P&L per unit of risk taken) with the AI PMs'."""
import time

from . import config as C
from .broker import pos_key
from .data import indicators

POD = "jason"
RISKS = (0.0025, 0.005, 0.01)       # risk per trade, share of NAV
STOPS = (1.0, 1.5, 2.0, 3.0)        # stop distance in daily ATRs
HOLDS = (5, 20, 60)                 # time stop, trading days
MAX_OPEN = 3


def fmt(px):
    return f"{px:,.2f}" if px >= 10 else f"{px:,.4f}"


class MyDesk:
    def __init__(self, floor):
        self.f = floor
        self.atr: dict = {}          # sym -> (last daily bar, daily ATR)

    def daily_atr(self, s):
        df = self.f.desk.daily.get(s)
        if df is None or len(df) < 20:
            return None
        last = str(df.index[-1])
        if self.atr.get(s, (None,))[0] != last:
            self.atr[s] = (last, float(indicators(df)["atr"]))
        return self.atr[s][1]

    def mine(self):
        return {k: p for k, p in self.f.broker.positions.items() if p["pod"] == POD}

    async def order(self, msg):
        f = self.f
        s = str(msg.get("sym", "")).upper()
        inst = C.INST.get(s)
        try:
            d, risk, stop_atr, hold = int(msg.get("dir", 0)), float(msg.get("risk", 0.005)), float(msg.get("stop", 2)), int(msg.get("hold", 20))
        except (TypeError, ValueError):
            return
        if not inst or d not in (1, -1):
            return
        risk, stop_atr, hold = min(max(risk, 0.001), 0.01), min(max(stop_atr, 0.5), 5.0), min(max(hold, 1), 120)
        trail = bool(msg.get("trail", True))
        thesis = " ".join(str(msg.get("why", "")).split())[:160]
        verb = "BUY" if d > 0 else "SELL SHORT"
        await f.say("boss", "decision", f"Jason wants to {verb} {s}" + (f": \"{thesis}\"" if thesis else ".") + " Rex, size it.",
                    pause=1.5, sym=s, act="trade", dir=d)

        async def veto(why):
            await f.say("rex", "risk", f"VETO on Jason's {s}: {why}", pause=1.5, sym=s, ok=False, target=POD)

        if d < 0 and not inst["shorts"]:
            return await veto(f"{s} can't be shorted here.")
        if not f.desk.is_open(s):
            return await veto(f"{s} is closed right now (crypto trades 24/7; ETFs and stocks 9:30-4 New York time).")
        okc, cwhy = f.compliance.check(POD, s, d)
        if not okc:
            await f.say("lena", "compliance", f"BLOCKED: Jason's {s}. {cwhy}. Rules apply to the founder too.", pause=1.5, sym=s, ok=False)
            return
        if pos_key(POD, s) in f.broker.positions:
            return await veto(f"you already hold {s}. Close it first.")
        if len(self.mine()) >= MAX_OPEN:
            return await veto(f"your desk already has {MAX_OPEN} open positions.")
        px, atr = f.desk.price(s), self.daily_atr(s)
        if not px or not atr:
            return await veto("no live price or daily history for it yet.")
        eq = f.broker.equity(f.prices())
        ok, qty, stop, why = f.size(inst, POD, d, px, atr, "normal", stop_atr, risk_cash=eq * risk)
        if not ok:
            return await veto(why)
        note = f.size_note
        await f.say("rex", "risk", f"APPROVED: {qty:g} {s} for Jason, stop {fmt(stop)} ({stop_atr:g} daily ATRs). Risk ${why:,.0f}.{note}",
                    pause=1.5, sym=s, ok=True, target=POD)
        await f.say("eddie", "order", f"Working Jason's order: {'buy' if d > 0 else 'sell'} {qty:g} {s}...", pause=2.0, sym=s, dir=d)
        if not f.desk.is_open(s):
            return
        key, fill, fee = f.broker.open(POD, s, d, qty, px, stop, ("Jason: " + thesis) if thesis else "Jason's call")
        df = f.desk.daily.get(s)
        f.broker.positions[key].update(trail_atr=stop_atr if trail else 1e9, max_bars=hold, tf="1d", risk0=float(why),
                                       last_day=str(df.index[-1].date()) if df is not None else None)    # day 0: the count starts tomorrow
        await f.say("eddie", "fill", f"FILLED {qty:g} {s} @ {fmt(fill)} for Jason (fees ${fee:,.2f}). Stop {fmt(stop)}, "
                    + (f"trailing at {stop_atr:g} ATRs" if trail else "fixed") + f", time stop {hold} trading days.", pause=1.0, sym=s)

    async def close(self, key):
        f = self.f
        p = f.broker.positions.get(key)
        if not p or p["pod"] != POD:
            return
        s = p["sym"]
        px = f.desk.price(s)
        if not px or not f.desk.is_open(s):
            p["close_at_open"] = True
            await f.say("eddie", "order", f"{s} is closed right now. I'll close Jason's position at the open.", pause=1, sym=s)
            return
        await f.exit(key, px, "Jason closed it")

    async def breakeven(self, key):
        f = self.f
        p = f.broker.positions.get(key)
        if not p or p["pod"] != POD:
            return
        px = f.desk.price(p["sym"]) or p["entry"]
        if (px - p["entry"]) * p["side"] <= 0:
            await f.say("rex", "risk", f"Jason's {p['sym']} isn't in profit yet, so the stop stays at {fmt(p['stop'])}.", pause=1, sym=p["sym"])
            return
        if (p["entry"] - p["stop"]) * p["side"] > 0:
            p["stop"] = p["entry"]
            await f.say("eddie", "trail", f"Moved Jason's {p['sym']} stop to breakeven ({fmt(p['entry'])}). It can't lose now, before costs.", sym=p["sym"])

    def snapshot(self):
        f = self.f
        px = f.prices()
        pos = [dict(key=k, sym=p["sym"], side=p["side"], qty=p["qty"], entry=p["entry"], last=px.get(p["sym"], p["entry"]), stop=p["stop"],
                    upl=f.broker.upl(k, px.get(p["sym"], p["entry"])), days=p.get("bars", 0), hold=p.get("max_bars"), why=p.get("why", ""),
                    trail=p.get("trail_atr", 0) < 1e8, pending=bool(p.get("close_at_open")), risk0=p.get("risk0"))
               for k, p in self.mine().items()]
        mine = [t for t in f.broker.trades if t.get("pod") == POD]
        rs = [t["r"] for t in mine if t.get("r") is not None]
        bots: dict = {}
        for t in f.broker.trades:
            if t.get("r") is not None and t.get("pod") != POD and not t.get("trim"):
                bots.setdefault(t["pod"], []).append(t["r"])
        board = [[f.names.get(k, k), len(v), sum(v) / len(v)] for k, v in bots.items()]
        if rs:
            board.append(["You", len(rs), sum(rs) / len(rs)])
        markets = []
        for i in C.INSTRUMENTS:
            s = i["sym"]
            last = px.get(s)
            if not last:
                continue
            atr = self.daily_atr(s)
            markets.append(dict(sym=s, cls=i["cls"], open=f.desk.is_open(s), shorts=i["shorts"], px=last, pv=i["pv"], step=i["step"],
                                atr_pct=atr / last if atr else None))
        return dict(open=pos, realized=f.broker.realized.get(POD, 0.0), upl=sum(p["upl"] for p in pos), n=len(mine),
                    wins=sum(1 for t in mine if t["pnl"] > 0), avg_r=sum(rs) / len(rs) if rs else None,
                    trades=[dict(sym=t["sym"], side=t.get("side"), pnl=t["pnl"], r=t.get("r"), reason=t.get("reason"), closed=t.get("closed"))
                            for t in mine[-12:]][::-1],
                    board=sorted(board, key=lambda x: -x[2]), markets=markets,
                    limits=dict(max_open=MAX_OPEN, risks=RISKS, stops=STOPS, holds=HOLDS))
