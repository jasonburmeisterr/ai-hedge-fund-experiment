"""The experiment log: Jason documents the AI hedge fund experiment publicly, every two weeks, with the SAME scoreboard
every time (good or bad), computed from the live books so nothing gets cherry-picked by accident.

Day 0 is October 7, 2026 (paper NAV at that day's official strike). Each update reports since Day 0 and since the last
saved update: paper NAV vs SPY over the same period (so a rising market isn't mistaken for skill), max drawdown,
strategies tested / passed, ML models tested / passed, trades and win rate, the notable moments, and every change Jason
made to the system (risk policy, announcements, team management, restricted list, plus his own notes)."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

from . import config as C

NY = ZoneInfo("America/New_York")
DAY0 = "2026-10-07"
EVERY_DAYS = 14


def _ts(day):
    """Day 0 starts at that day's official NAV strike (4:15 pm New York)."""
    return datetime.fromisoformat(day).replace(hour=16, minute=15, tzinfo=NY).timestamp()


class Experiment:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.updates: list = st.get("updates", [])
        self.changes: list = st.get("changes", [])[-300:]       # [{t, text}]

    def to_state(self):
        return dict(updates=self.updates, changes=self.changes[-300:])

    def change(self, text):
        self.changes.append(dict(t=time.time(), text=str(text)[:200]))
        if len(self.changes) > 350:
            del self.changes[:-300]

    # ── numbers ──
    def _nav_at(self, ts):
        """Paper NAV (per 100) at a moment: the official strike for that day if there is one, else the equity curve."""
        day = datetime.fromtimestamp(ts, NY).strftime("%Y-%m-%d")
        s = next((x for x in self.f.fundops.strikes if x["day"] == day), None)
        if s:
            return s["gross"]
        cur = [c for c in self.f.curve if c[0] <= ts]
        eq = cur[-1][1] if cur else (self.f.curve[0][1] if self.f.curve else C.STARTING_CASH)
        return 100 * eq / C.STARTING_CASH

    def _spy_at(self, ts):
        df = (self.f.desk.daily or self.f.lab.daily or {}).get("SPY")
        if df is None or not len(df):
            return None
        idx = [datetime.fromtimestamp(t.timestamp(), NY) if hasattr(t, "timestamp") else t for t in df.index]
        day = datetime.fromtimestamp(ts, NY).date()
        vals = [float(v) for t, v in zip(idx, df["Close"].values) if t.date() <= day]
        return vals[-1] if vals else None

    def build(self, since_ts=None):
        f = self.f
        now = time.time()
        t0 = _ts(DAY0)
        start = since_ts or t0
        px = f.prices()
        nav_now = 100 * f.broker.equity(px) / C.STARTING_CASH
        spy_now = px.get("SPY") or self._spy_at(now)
        def period(a):
            nav_a, spy_a = self._nav_at(a), self._spy_at(a)
            curve = [c[1] for c in f.curve if c[0] >= a] + [f.broker.equity(px)]
            eq = np.array(curve, float)
            dd = float((eq / np.maximum.accumulate(eq) - 1).min()) if len(eq) else 0.0
            trades = [t for t in f.broker.trades if t.get("closed", 0) >= a]
            wins = sum(1 for t in trades if t["pnl"] > 0)
            lab = [e for e in f.lab.log if e.get("t", 0) >= a and e.get("tf") in ("1d", "1h")]
            models = [m for m in f.mlab.models if m["t"] >= a]
            pods = []
            for p in f.roster:
                h = [x for x in f.pod_hist.get(p["id"], []) if x[0] >= a]
                pods.append([p["name"], round((f.broker.pod_pnl(p["id"], px) - h[0][1]) if h else 0.0, 2)])
            return dict(nav_from=round(nav_a, 3), nav_to=round(nav_now, 3), ret=nav_now / nav_a - 1 if nav_a else 0.0,
                        spy_ret=(spy_now / spy_a - 1) if spy_a and spy_now else None, maxdd=dd, trades=len(trades),
                        win=wins / len(trades) if trades else None, realized=float(sum(t["pnl"] for t in trades)),
                        lab_tested=len(lab), lab_passed=sum(1 for e in lab if e.get("passed")),
                        models_tested=len(models), models_passed=sum(1 for m in models if m["passed"]),
                        options=sum(1 for t in trades if "condor" in str(t.get("sym", "")) or "call" in str(t.get("sym", "")) or "put" in str(t.get("sym", ""))),
                        pods=sorted(pods, key=lambda x: -x[1]), days=round((now - a) / 86400, 1),
                        start_day=datetime.fromtimestamp(a, NY).strftime("%b %d, %Y"))
        total = period(t0)
        last = self.updates[-1] if self.updates else None
        since_last = period(last["t"]) if last else None
        # notable moments, from the digest ring + the CIO / compliance logs
        moments = []
        for x in f.digest.items:
            if x["t"] < start:
                continue
            if x["kind"] in ("hire", "fire", "upgrade", "announce") or (x["kind"] == "model_verdict" and "PASSED" in x["text"]) or \
                    (x["kind"] == "incubator" and ("graduat" in x["text"] or "goes into" in x["text"])):
                moments.append(dict(t=x["t"], who=x["name"], text=x["text"]))
        blocks = sum(1 for x in f.compliance.log if x["t"] >= start and x["result"] == "BLOCK")
        passes = sum(1 for d in f.cio.decisions if d["t"] >= start and d["verdict"] == "PASS")
        if blocks:
            moments.append(dict(t=now, who="Lena", text=f"Compliance blocked {blocks} order{'s' if blocks != 1 else ''}."))
        if passes:
            moments.append(dict(t=now, who="The CIO", text=f"The CIO passed on {passes} trade idea{'s' if passes != 1 else ''}."))
        beta = list(f.cio.beta)
        lesson = (f.minds.firm_lessons[-1]["text"] if f.minds.firm_lessons else "")
        changes = [c for c in self.changes if c["t"] >= start]
        return dict(day0=DAY0, n=len(self.updates) + 1, total=total, since_last=since_last, last=last,
                    moments=moments[-8:], changes=changes[-12:], lesson=lesson, beta=[f.names.get(b, b) for b in beta],
                    due=now - (last["t"] if last else t0) >= EVERY_DAYS * 86400, next_due=(last["t"] if last else t0) + EVERY_DAYS * 86400,
                    var99=(f.riskrep.last or {}).get("var99_pct"), policy=self.policy_name())

    def policy_name(self):
        s = self.f.settings
        for k, p in self.f.PRESETS.items():
            if all(abs(float(s.get(key, getattr(C, key))) - float(v)) < 1e-9 for key, v in p.items() if key != "label"):
                return p["label"]
        return "custom"

    def save(self, note=""):
        b = self.build()
        rec = dict(n=b["n"], t=time.time(), day=datetime.now(NY).strftime("%Y-%m-%d"), nav=b["total"]["nav_to"], ret=b["total"]["ret"],
                   spy_ret=b["total"]["spy_ret"], note=str(note)[:300])
        self.updates.append(rec)
        return rec
