"""'While you were away': what happened on the floor since Jason last looked.

Floor.say() feeds the notable moments (hires, fires, upgrades, incubator moves, investor letters, risk warnings and
vetoes) into a small persisted ring; the rest comes straight from the books: the equity curve, closed and newly opened
trades, and the research log."""
import time

from . import config as C

KINDS = {"hire", "fire", "upgrade", "incubator", "letter", "risk", "model_verdict", "announce"}
KEEP = 300


class Digest:
    def __init__(self, floor, st: list | None):
        self.f = floor
        self.items: list = list(st or [])[-KEEP:]

    def to_state(self):
        return self.items[-KEEP:]

    def note(self, kind, agent, name, text, extra):
        if kind not in KINDS or (kind == "risk" and extra.get("ok") is not False):
            return
        self.items.append(dict(t=time.time(), kind=kind, agent=agent, name=name, text=str(text)[:240]))
        if len(self.items) > KEEP + 50:
            del self.items[:-KEEP]

    def build(self, since: float) -> dict:
        f = self.f
        now = time.time()
        since = max(since, now - 30 * 86400)
        px = f.prices()
        eq = f.broker.equity(px)
        then = next((c[1] for c in f.curve if c[0] >= since), eq)
        trades = [t for t in f.broker.trades if t.get("closed", 0) >= since]
        by_pod: dict = {}
        for t in trades:
            by_pod[t["pod"]] = by_pod.get(t["pod"], 0.0) + t["pnl"]
        opened = [dict(pod=f.names.get(p["pod"], p["pod"]), sym=p["sym"], side=p["side"]) for p in f.broker.positions.values() if p["opened"] >= since]
        research = [dict(name=e["name"], passed=e.get("passed"), reason=e.get("reason", "")[:120]) for e in f.lab.log if e.get("t", 0) >= since]
        notes = [x for x in self.items if x["t"] >= since]
        best = max(trades, key=lambda t: t["pnl"], default=None)
        worst = min(trades, key=lambda t: t["pnl"], default=None)
        tr = lambda t: dict(pod=f.names.get(t["pod"], t["pod"]), sym=t["sym"], pnl=t["pnl"]) if t else None
        return dict(since=since, hours=(now - since) / 3600, eq_then=then, eq_now=eq, nav_then=100 * then / C.STARTING_CASH,
                    nav_now=100 * eq / C.STARTING_CASH, n_trades=len(trades), realized=sum(t["pnl"] for t in trades),
                    by_pod=sorted(([f.names.get(k, k), v] for k, v in by_pod.items()), key=lambda x: -x[1]),
                    best=tr(best), worst=tr(worst), opened=opened[:12], research=research[-12:],
                    passed=sum(1 for e in research if e["passed"]), tested=len(research),
                    notes=[dict(t=x["t"], kind=x["kind"], name=x["name"], text=x["text"]) for x in notes
                           if x["kind"] != "risk"][-12:],
                    risk=[dict(t=x["t"], text=x["text"]) for x in notes if x["kind"] == "risk"][-6:],
                    n_risk=sum(1 for x in notes if x["kind"] == "risk"))
