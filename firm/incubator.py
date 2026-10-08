"""The Incubator: strategies earn capital with a live paper record before they get a desk.

A backtest, however strict, is still history the lab could see. The only clean test is the future. Strategies that
pass the lab's bar but can't get a desk (all desks full) are not thrown away or hired on backtest alone: they trade a
SHADOW book with no capital. Every day the incubator replays each one over the newest data and keeps only the trades
that started AFTER it was admitted. That forward record is genuine out-of-sample evidence.

Graduation: >= GRAD_TRADES forward trades, forward PF >= GRAD_PF and a positive forward result. A graduate takes a free
desk, or replaces the weakest hire if it has done better forward than that hire has done live. Dropped: forward PF below
DROP_PF after GRAD_TRADES trades, or no more than 2 trades in DROP_DAYS days. At most CAPACITY strategies incubate at once
(a newcomer needs a clearly better backtest to replace one without a record yet). No orders, no capital, no risk: it is evidence gathering, run every few hours."""
import asyncio
import time

import pandas as pd

from . import config as C
from .backtest import run_market
from .strategies import describe

CAPACITY = 12
EVICT_DAYS = 45          # a strategy with no forward trades after this long can be retired to make room
EVICT_EDGE = 0.3        # ...or replaced by a newcomer whose backtest PF is this much better
GRAD_TRADES = 8
GRAD_PF = 1.3
DROP_PF = 0.8
DROP_DAYS = 180
MAX_DAYS = 240           # still not graduated after 8 months: retired
EVERY_H = 6


def _naive(ts):
    ts = pd.Timestamp(ts)
    return ts.tz_convert("America/New_York").tz_localize(None) if ts.tzinfo else ts


class Incubator:
    def __init__(self, floor, st: dict):
        self.f = floor
        self.items: list = st.get("items", [])       # {id, name, family, params, markets, tf, by, since, bt_pf, result, status, fwd}
        self.last = st.get("last", 0.0)
        self.seeded = st.get("seeded", False)
        self.running = False

    def to_state(self):
        act = [x for x in self.items if x["status"] == "incubating"]
        done = [x for x in self.items if x["status"] != "incubating"][-40:]
        return dict(items=sorted(act + done, key=lambda x: x["since"]), last=self.last, seeded=self.seeded)

    def active(self):
        return [x for x in self.items if x["status"] == "incubating"]

    # ── admission ──
    async def admit(self, e, by=None, why="all desks are full"):
        """e: a research-log entry that PASSED the lab's bar."""
        f = self.f
        if any(x["name"] == e["name"] and x["status"] == "incubating" for x in self.items):
            return
        act = self.active()
        if len(act) >= CAPACITY:
            # Room is only made for a clearly better idea, or by retiring one that has been too slow to show anything.
            # (A daily strategy needs weeks to log 8 forward trades: evicting by age alone would never let one graduate.)
            idle = [x for x in act if not x["fwd"]["n"]]
            slow = [x for x in idle if time.time() - x["since"] > EVICT_DAYS * 86400]
            weakest = min(idle, key=lambda x: x["bt_pf"], default=None)
            out = min(slow, key=lambda x: x["since"]) if slow else (weakest if weakest and e["oos"]["pf"] > weakest["bt_pf"] + EVICT_EDGE else None)
            if not out:
                await f.say("juno", "incubator", f"\"{e['name']}\" passed, but the incubator is full and it isn't clearly better than what's "
                            "already earning a record. Filed.", pause=2)
                return
            out["status"] = "dropped"
            out["why"] = (f"no forward trades in {EVICT_DAYS} days: too slow to judge" if out in slow
                          else f"replaced by \"{e['name']}\" (backtest PF {e['oos']['pf']:.2f} vs {out['bt_pf']:.2f}) before it had forward trades")
        item = dict(id=f"i{int(time.time() * 1000) % 10**10}", name=e["name"], family=e["family"], params=e["params"],
                    markets=e["markets"], tf=e.get("tf", "1d"), by=by or e.get("by", "ava"), since=time.time(),
                    bt_pf=e["oos"]["pf"], result=e.get("result", ""), status="incubating", why=why,
                    desc=describe(e["family"], e["params"]), fwd=dict(n=0, pf=0.0, ret=0.0, win=0.0, last=None))
        self.items.append(item)
        await f.say("juno", "incubator", f"\"{e['name']}\" goes into the incubator ({why}). It paper-trades a shadow book with no capital "
                    f"until it proves itself forward: {GRAD_TRADES}+ trades, PF {GRAD_PF}+.", pause=3)
        self.last = 0          # evaluate soon

    def seed(self):
        """First run: strategies that passed the lab in the past but never got a desk."""
        if self.seeded:
            return 0
        self.seeded = True
        on_desk = {a.get("idea") for a in self.f.roster} | {a["name"] for a in self.f.roster}
        seen, n = set(), 0
        for e in reversed(self.f.lab.log):
            if not e.get("passed") or e.get("tune") or e["name"] in on_desk or e["name"] in seen or e.get("tf") not in ("1d", "1h"):
                continue
            seen.add(e["name"])
            self.items.append(dict(id=f"i{int(time.time() * 1000) % 10**10 + n}", name=e["name"], family=e["family"], params=e["params"],
                                   markets=e["markets"], tf=e.get("tf", "1d"), by=e.get("by", "ava"), since=time.time(), bt_pf=e["oos"]["pf"],
                                   result=e.get("result", ""), status="incubating", why="passed the lab earlier but never got a desk",
                                   desc=describe(e["family"], e["params"]), fwd=dict(n=0, pf=0.0, ret=0.0, win=0.0, last=None)))
            n += 1
            if n >= CAPACITY - 2:
                break
        return n

    # ── the forward record ──
    def forward(self, item):
        hist = self.f.lab.history_for(item.get("tf", "1d"))
        since = _naive(pd.Timestamp(item["since"], unit="s", tz="UTC"))
        rets, last = [], None
        for sym in item["markets"]:
            df = hist.get(sym)
            if df is None or len(df) < 300:
                continue
            idx = pd.DatetimeIndex(df.index)
            idx = idx.tz_convert("America/New_York").tz_localize(None) if idx.tz is not None else idx
            tr = run_market(df, sym, item["family"], item["params"])
            for t in tr:
                if idx[t["i"]] >= since:
                    rets.append(t["ret"])
                    last = max(last or idx[min(t["j"], len(idx) - 1)], idx[min(t["j"], len(idx) - 1)])
        wins, losses = sum(r for r in rets if r > 0), -sum(r for r in rets if r < 0)
        return dict(n=len(rets), pf=round(float(wins / losses), 2) if losses > 0 else (9.99 if wins > 0 else 0.0),
                    ret=round(float(sum(rets)), 4), win=round(float(sum(r > 0 for r in rets) / len(rets)), 2) if rets else 0.0,
                    last=str(last.date()) if last is not None else None)

    async def step(self):
        f = self.f
        if self.running or not f.lab.recertified or not f.lab.daily or f.lab.running:
            return
        if not self.seeded:
            n = self.seed()
            if n:
                await f.say("juno", "incubator", f"Opened the incubator with {n} strategies that passed the lab before but never got a desk. "
                            "They paper-trade with no capital; the ones that prove themselves forward get hired.", pause=3)
        if time.time() - self.last < EVERY_H * 3600 or not self.active():
            return
        self.running = True
        try:
            if time.time() - f.lab.hist_at > 6 * 3600:          # the lab only refreshes history in its own sessions
                await f.lab._get_history()
                f.lab.status = "idle"
            items = self.active()
            fwd = await asyncio.to_thread(lambda: [self.forward(x) for x in items])
            for x, r in zip(items, fwd):
                x["fwd"] = r
            self.last = time.time()
            await self.decide()
        except Exception as e:      # never let the incubator crash the floor; retry in 30 minutes
            self.last = time.time() - EVERY_H * 3600 + 1800
            await f.say("dot", "chatter", f"Incubator update failed: {e!r}"[:140])
        finally:
            self.running = False

    async def decide(self):
        f = self.f
        for x in self.active():
            r, days = x["fwd"], (time.time() - x["since"]) / 86400
            if r["n"] >= GRAD_TRADES and (r["pf"] < DROP_PF or r["ret"] <= 0):
                x["status"], x["why"] = "dropped", f"forward PF {r['pf']:.2f} over {r['n']} trades: the backtest edge didn't show up live"
                await f.say("juno", "incubator", f"Incubator: dropped \"{x['name']}\" ({x['why']}).", pause=2, ok=False)
            elif r["n"] >= 2 * GRAD_TRADES and r["pf"] < GRAD_PF:
                x["status"], x["why"] = "dropped", f"{r['n']} forward trades without clearing PF {GRAD_PF} (PF {r['pf']:.2f})"
                await f.say("juno", "incubator", f"Incubator: dropped \"{x['name']}\" ({x['why']}).", pause=2)
            elif days > MAX_DAYS:
                x["status"], x["why"] = "dropped", f"{days:.0f} days without graduating"
                await f.say("juno", "incubator", f"Incubator: retired \"{x['name']}\" ({x['why']}).", pause=2)
            elif days > DROP_DAYS and r["n"] <= 2:
                x["status"], x["why"] = "dropped", f"only {r['n']} trades in {days:.0f} days: too slow to judge"
                await f.say("juno", "incubator", f"Incubator: dropped \"{x['name']}\" ({x['why']}).", pause=2)
            elif r["n"] >= GRAD_TRADES and r["pf"] >= GRAD_PF and r["ret"] > 0:
                if await self.graduate(x):
                    x["status"], x["why"] = "graduated", f"forward PF {r['pf']:.2f}, {r['ret']:+.1%} over {r['n']} trades"

    async def graduate(self, x):
        """Hire it if a desk is free, or if it did better forward than the weakest hire did live."""
        f = self.f
        hires = [a for a in f.roster if not a.get("founder")]
        if len(hires) >= C.MAX_HIRES:
            def live_pf(a):
                tr = [t for t in f.broker.trades if t.get("pod") == a["id"] and not t.get("trim") and t.get("opened", 0) >= a.get("since", 0)]
                w, l = sum(t["pnl"] for t in tr if t["pnl"] > 0), -sum(t["pnl"] for t in tr if t["pnl"] < 0)
                return (w / l) if l > 0 else (9.99 if w > 0 else 1.0), len(tr)
            worst = min(hires, key=lambda a: (a["id"] not in f.stopped, f.score.stats(a["id"])["trust"], live_pf(a)[0]))
            pf, n = live_pf(worst)
            if worst["id"] not in f.stopped and not (n >= 5 and x["fwd"]["pf"] > pf + 0.2):
                return False                      # keep waiting for a desk (or for the weakest hire to slip)
            await f.lab.fire(worst, f"replaced by \"{x['name']}\", which proved itself in the incubator")
        e = dict(name=x["name"], family=x["family"], params=x["params"], markets=x["markets"], tf=x.get("tf", "1d"),
                 result=f"{x['result']} | incubator forward: PF {x['fwd']['pf']:.2f}, {x['fwd']['ret']:+.1%}, {x['fwd']['n']} trades",
                 oos=dict(pf=x["bt_pf"]))
        await f.say("boss", "hire", f"\"{x['name']}\" graduates from the incubator: forward PF {x['fwd']['pf']:.2f} on {x['fwd']['n']} live paper trades.", pause=3)
        await f.lab.hire(e, mentor=x["by"] if x["by"] in f.names and x["by"] != "ava" else None, force=True)
        return True

    def snapshot(self):
        show = [x for x in self.items if x["status"] == "incubating"] + [x for x in self.items if x["status"] != "incubating"][-6:]
        return dict(items=[dict({k: v for k, v in x.items() if k != "params"}, days=round((time.time() - x["since"]) / 86400, 1))
                           for x in show], running=self.running, last=self.last,
                    rules=dict(grad_trades=GRAD_TRADES, grad_pf=GRAD_PF, drop_pf=DROP_PF, drop_days=DROP_DAYS, capacity=CAPACITY))

    def brief_line(self):
        act = self.active()
        if not act:
            return ""
        return "Incubator (shadow book, no capital): " + "; ".join(
            f"{x['name']} ({x['desc']}; " + (f"{x['fwd']['n']} forward trades, PF {x['fwd']['pf']:.2f})" if x["fwd"]["n"] else "no forward trades yet)")
            for x in act[:8])
