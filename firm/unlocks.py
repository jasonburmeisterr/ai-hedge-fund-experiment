"""Earned upgrades: paid tools the agents must EARN with a proven paper record before Jason buys them.

Jason's rule: "keep them working for it, and when they have it, I'll buy it." Each unlock has hard, measurable bars.
When every bar is met, the CIO tells Jason on the Wire. Nothing is ever bought automatically: Jason buys it himself,
after being told the exact price and how it's billed."""
import time

from . import config as C

FUTURES = {i["sym"] for i in C.INSTRUMENTS if i["cls"] == "futures"}

UNLOCKS = [
    dict(id="cme_rt", name="Real-time CME futures data",
         why="Futures (MNQ, MGC) trade on ~10-minute-delayed Yahoo prices. Real-time data costs a monthly exchange fee, "
             "so the futures book has to prove it's worth paying for.",
         bars=[("trades", "closed futures trades", 20), ("pf", "profit factor after costs", 1.2),
               ("pnl", "net P&L ($)", 0.01), ("days", "days of futures trading", 30)]),
    dict(id="tf_15m", name="15-minute timeframe (next rung of the ladder: 1h -> 15m -> 5m -> 1m -> ticks)",
         why="Faster bars only get built once the 1-hour PMs prove they make money after costs on live paper trades. "
             "Free to unlock; it's Claude's build work, not a purchase. 1-minute and tick data will need a US server and paid feeds.",
         bars=[("trades", "closed 1-hour trades", 30), ("pf", "profit factor after costs", 1.2),
               ("pnl", "net P&L ($)", 0.01), ("days", "days of 1-hour trading", 30)]),
]


def tf_stats(trades, tf):
    tt = [t for t in trades if t.get("tf") == tf]
    wins = sum(t["pnl"] for t in tt if t["pnl"] > 0)
    losses = -sum(t["pnl"] for t in tt if t["pnl"] < 0)
    first = min((t.get("opened") or t.get("closed") or time.time() for t in tt), default=None)
    return dict(trades=len(tt), pf=(wins / losses) if losses else (99.0 if wins else 0.0), pnl=sum(t["pnl"] for t in tt),
                days=(time.time() - first) / 86400 if first else 0.0)


def futures_stats(trades):
    fut = [t for t in trades if t.get("sym") in FUTURES]
    wins = sum(t["pnl"] for t in fut if t["pnl"] > 0)
    losses = -sum(t["pnl"] for t in fut if t["pnl"] < 0)
    first = min((t.get("opened") or t.get("closed") or time.time() for t in fut), default=None)
    return dict(trades=len(fut), pf=(wins / losses) if losses else (99.0 if wins else 0.0), pnl=sum(t["pnl"] for t in fut),
                days=(time.time() - first) / 86400 if first else 0.0)


class Unlocks:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.earned: dict = st.get("earned", {})          # id -> time first earned

    def to_state(self):
        return dict(earned=self.earned)

    def progress(self):
        stats = {"cme_rt": futures_stats(self.floor.broker.trades), "tf_15m": tf_stats(self.floor.broker.trades, "1h")}
        out = []
        for u in UNLOCKS:
            s = stats[u["id"]]
            bars = [dict(key=k, label=lab, need=need, have=s[k], ok=s[k] >= need) for k, lab, need in u["bars"]]
            out.append(dict(id=u["id"], name=u["name"], why=u["why"], bars=bars, done=all(b["ok"] for b in bars),
                            earned=self.earned.get(u["id"])))
        return out

    async def check(self):
        for u in self.progress():
            if u["done"] and not u["earned"]:
                self.earned[u["id"]] = time.time()
                await self.floor.say("boss", "system", f"The team EARNED it: {u['name']}. Telling Jason.")
                await self.floor.board.post("fund", "boss", "jason", "unlock",
                                            f"We earned an upgrade: {u['name']}. " + "; ".join(f"{b['label']} {b['have']:.2f} (needed {b['need']})" for b in u["bars"])
                                            + ". Your call: check the price and buy it only if you still want it.")
