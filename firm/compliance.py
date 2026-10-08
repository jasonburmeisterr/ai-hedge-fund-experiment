"""Lena, compliance: every order is checked before it goes out, and everything is logged (the way a real fund works).

Pre-trade checks:
  - Restricted list: names Jason (or the firm) has restricted can't be traded by anyone. Hard block.
  - Earnings blackout: no NEW positions in single stocks within 2 days of their earnings date (event risk the
    strategies weren't built for). Dates come from Yahoo Finance, refreshed daily. Hard block.
  - Wash-sale flag: re-buying a name the fund closed at a loss in the last 30 days. Allowed, but flagged (a US tax rule
    that would defer the loss), so the log shows it.
Every check (pass, flag or block) goes into the compliance log; at 4:30 pm New York time Lena posts the daily attestation."""
import asyncio
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import config as C

NY = ZoneInfo("America/New_York")
BLACKOUT_DAYS = 2
WASH_DAYS = 30


class Compliance:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.restricted: list = st.get("restricted", [])          # [{sym, why, t, by}]
        self.log: list = st.get("log", [])[-400:]
        self.earnings: dict = st.get("earnings", {})               # sym -> "YYYY-MM-DD"
        self.earn_at = float(st.get("earn_at", 0))
        self.attest_day = st.get("attest_day")

    def to_state(self):
        return dict(restricted=self.restricted, log=self.log[-400:], earnings=self.earnings, earn_at=self.earn_at, attest_day=self.attest_day)

    def _entry(self, pod, sym, side, result, why):
        self.log.append(dict(t=time.time(), pod=pod, name=self.f.names.get(pod, pod), sym=sym, side=side, result=result, why=why))
        if len(self.log) > 450:
            del self.log[:-400]

    def check(self, pod, sym, side, opening=True):
        """-> (ok, why). Logs every check."""
        base = sym.split(" ")[0]
        r = next((x for x in self.restricted if x["sym"] == base), None)
        if r:
            why = f"{base} is on the restricted list ({r.get('why') or 'restricted by ' + self.f.names.get(r.get('by'), 'the firm')})"
            self._entry(pod, base, side, "BLOCK", why)
            return False, why
        if opening and C.INST.get(base, {}).get("cls") == "stock" and base in self.earnings:
            try:
                d = date.fromisoformat(self.earnings[base])
                days = (d - datetime.now(NY).date()).days
                if 0 <= days <= BLACKOUT_DAYS:
                    why = f"earnings blackout: {base} reports {d:%b %d} ({days} day{'s' if days != 1 else ''} away)"
                    self._entry(pod, base, side, "BLOCK", why)
                    return False, why
            except ValueError:
                pass
        if opening and side > 0:
            cut = time.time() - WASH_DAYS * 86400
            loss = next((t for t in reversed(self.f.broker.trades) if t.get("sym") == base and t.get("closed", 0) >= cut and t["pnl"] < 0), None)
            if loss:
                why = f"wash-sale flag: {base} was closed at a ${-loss['pnl']:,.0f} loss within {WASH_DAYS} days (allowed; the loss would be deferred for tax)"
                self._entry(pod, base, side, "FLAG", why)
                return True, why
        self._entry(pod, base, side, "PASS", "")
        return True, ""

    async def restrict(self, sym, on, why="", by="jason"):
        sym = str(sym).upper().strip()[:12]
        if not sym:
            return
        self.restricted = [x for x in self.restricted if x["sym"] != sym]
        if on:
            self.restricted.append(dict(sym=sym, why=str(why)[:120], t=time.time(), by=by))
            await self.f.say("lena", "compliance", f"{sym} is now RESTRICTED{': ' + why if why else ''}. No one opens a position in it until it's lifted.", pause=1)
        else:
            await self.f.say("lena", "compliance", f"{sym} is off the restricted list.", pause=1)

    async def refresh_earnings(self):
        stocks = [i["sym"] for i in C.INSTRUMENTS if i["cls"] == "stock"]
        if not stocks or time.time() - self.earn_at < 12 * 3600:
            return
        self.earn_at = time.time()
        def get():
            import yfinance as yf
            out = {}
            for s in stocks:
                try:
                    cal = yf.Ticker(C.INST[s]["id"]).calendar or {}
                    d = (cal.get("Earnings Date") or [None])[0]
                    if d:
                        out[s] = str(d)[:10]
                except Exception:
                    pass
            return out
        got = await asyncio.to_thread(get)
        if got:
            self.earnings.update(got)

    async def step(self):
        await self.refresh_earnings()
        t = datetime.now(NY)
        day = t.strftime("%Y-%m-%d")
        if t.weekday() < 5 and (t.hour, t.minute) >= (16, 30) and self.attest_day != day:
            self.attest_day = day
            today = [x for x in self.log if datetime.fromtimestamp(x["t"], NY).strftime("%Y-%m-%d") == day]
            b = sum(1 for x in today if x["result"] == "BLOCK")
            fl = sum(1 for x in today if x["result"] == "FLAG")
            nxt = ", ".join(f"{s} {d}" for s, d in self.earnings.items())
            await self.f.say("lena", "compliance", f"Daily attestation: {len(today)} orders checked, {b} blocked, {fl} flagged. "
                             f"Restricted list: {', '.join(x['sym'] for x in self.restricted) or 'empty'}."
                             + (f" Next earnings: {nxt}." if nxt else "") + " Signed off.", pause=1)

    def snapshot(self):
        day = datetime.now(NY).strftime("%Y-%m-%d")
        today = [x for x in self.log if datetime.fromtimestamp(x["t"], NY).strftime("%Y-%m-%d") == day]
        return dict(restricted=self.restricted, log=self.log[-40:][::-1], earnings=self.earnings,
                    today=dict(n=len(today), blocked=sum(1 for x in today if x["result"] == "BLOCK"), flagged=sum(1 for x in today if x["result"] == "FLAG")),
                    rules=[f"Restricted list: hard block", f"Earnings blackout: no new single-stock positions within {BLACKOUT_DAYS} days of earnings",
                           f"Wash-sale flag: re-buying a {WASH_DAYS}-day loser is allowed but logged"])
