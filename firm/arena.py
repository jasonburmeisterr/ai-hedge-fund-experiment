"""Beat the Bots: Jason calls the direction of a few markets; graded on the next daily close, against two bots.

A call is "will it CLOSE above (or below) where it trades right now?" so watching the day's move gives no free edge.
It is graded by the first completed daily bar that closes after the call (stocks/ETFs: 4 pm New York; crypto: the UTC day).
The bots call the same thing at the same moment: Ava (the AI analyst's latest view, if she has one) and the trend bot
(20-day momentum). Sam grades everyone the same way he grades the PMs. Practice for a future quant: honest, scored
feedback on market calls. No money, no orders."""
import time

import pandas as pd

from . import config as C

MARKETS = ["SPY", "QQQ", "BTC", "GLD", "TLT"]


def bar_end(sym, day) -> float:
    """Unix time when the daily bar dated `day` closes."""
    d = pd.Timestamp(day).tz_localize(None).normalize()
    if C.INST[sym]["cls"] == "crypto":
        return (d + pd.Timedelta(days=1)).tz_localize("UTC").timestamp()
    return (d + pd.Timedelta(hours=16)).tz_localize("America/New_York").timestamp()


class Arena:
    def __init__(self, floor, st: dict):
        self.f = floor
        self.calls: list = st.get("calls", [])     # {id, t, sym, dir, px, ava, trend, status, ret, day}

    def to_state(self):
        return dict(calls=self.calls[-400:])

    def score(self, who):
        g = [c for c in self.calls if c["status"] == "graded" and c.get(who)]
        hits = sum(1 for c in g if c[who] * c["ret"] > 0)
        return dict(n=len(g), hits=hits, rate=round(hits / len(g), 3) if g else None)

    async def call(self, sym, d):
        f = self.f
        if sym not in MARKETS or d not in (1, -1):
            return
        if any(c["sym"] == sym and c["status"] == "open" for c in self.calls):
            await f.say("sam", "arena", f"You already have an open {sym} call, Jason. One per market until it's graded.", pause=1)
            return
        px, df = f.desk.price(sym), f.desk.daily.get(sym)
        if not px or df is None or len(df) < 25:
            return
        v = f.views.get(sym)
        ava = (1 if v["bias"] > 0 else -1) if v and time.time() - v["t"] < 6 * 3600 and abs(v["bias"]) >= 0.2 else 0
        c = df["Close"]
        trend = 1 if c.iloc[-1] >= c.iloc[-21] else -1
        self.calls.append(dict(id=f"a{int(time.time() * 1000)}", t=time.time(), sym=sym, dir=d, px=float(px), ava=ava, trend=trend,
                               status="open", ret=None, day=None))
        bots = f"Ava: {'up' if ava > 0 else 'down' if ava < 0 else 'no view'}, trend bot: {'up' if trend > 0 else 'down'}"
        await f.say("sam", "arena", f"Logged: Jason says {sym} closes {'ABOVE' if d > 0 else 'BELOW'} {px:,.2f}. {bots}. Graded at the next close.", pause=1)

    async def grade(self):
        f = self.f
        for c in self.calls:
            if c["status"] != "open":
                continue
            df = f.desk.daily.get(c["sym"])
            if df is None or not len(df):
                continue
            for day, close in zip(df.index[-5:], df["Close"].iloc[-5:]):
                if bar_end(c["sym"], day) > c["t"] + 60:               # the first bar that closed after the call
                    if bar_end(c["sym"], day) > time.time():
                        break                                          # not closed yet
                    c.update(status="graded", ret=float(close) / c["px"] - 1, day=str(pd.Timestamp(day).date()))
                    j, a, t = self.score("dir"), self.score("ava"), self.score("trend")
                    await f.say("sam", "arena", f"Jason's {c['sym']} call: {'RIGHT' if c['dir'] * c['ret'] > 0 else 'WRONG'} ({c['ret']:+.2%}). "
                                f"Season: Jason {j['hits']}/{j['n']} · Ava {a['hits']}/{a['n']} · trend bot {t['hits']}/{t['n']}.", pause=1,
                                ok=c["dir"] * c["ret"] > 0)
                    break

    def snapshot(self):
        rows = self.f.desk.market_rows()
        mk = {s: dict(px=self.f.desk.price(s), chg=(rows.get(s) or {}).get("chg"), name=C.INST[s]["name"]) for s in MARKETS}
        return dict(markets=mk, calls=self.calls[-40:], score=dict(jason=self.score("dir"), ava=self.score("ava"), trend=self.score("trend")),
                    open=[c for c in self.calls if c["status"] == "open"])
