"""Rex's risk book: limits on the WHOLE fund, across pods.

Each pod sizes its own trades and can't see the other pods' books. That's how three trend PMs (Mo, Vega, Quinn) all
bought SPY on the same day and the fund ended up ~75% in one ETF. Multi-manager funds stop this centrally:
  - per market: all pods together hold at most MAX_SYM_NOTIONAL of NAV in one market (same direction; hedges offset)
  - per group of look-alike markets (config.RISK_GROUPS: US stocks, bonds, metals, crypto, ...): at most MAX_GROUP_NOTIONAL
New trades only get the room that's left. If the book is already over a limit by more than TRIM_SLACK (prices moved,
or a book from before these rules), Rex trims every pod in it pro rata, during market hours.
Stock/ETF debit spreads count at ~SPREAD_DELTA of the shares they control. Opal's Deribit condors are near delta-neutral
and stay under the options risk rules."""
import math
import time

from . import config as C
from .stockopts import MULT

SPREAD_DELTA = 0.30      # a 0.55/0.25-delta debit vertical moves like ~0.30 of the shares it controls
TRIM_SLACK = 0.10        # trim only when 10% over a limit (so normal price drift doesn't cause constant trimming)


def group_of(sym):
    return C.SYM_GROUP.get(sym, sym)


class RiskBook:
    def __init__(self, floor):
        self.f = floor
        self.warned: dict = {}       # "sym:SPY" / "grp:US stocks" -> day we said it's over (market closed)

    def legs(self, px):
        """Every directional exposure in the fund: (pod, sym, signed $ notional, position key or None)."""
        f = self.f
        out = [(p["pod"], p["sym"], p["side"] * p["qty"] * C.INST[p["sym"]]["pv"] * px.get(p["sym"], p["entry"]), k)
               for k, p in f.broker.positions.items()]
        for s in f.sopt.mine().values():
            sym = s["cur"]
            out.append((s["pod"], sym, s.get("dir", 1) * SPREAD_DELTA * MULT * s["legs"][0]["qty"] * px.get(sym, s.get("opened_px", 0.0)), None))
        return out

    def exposure(self, px):
        by_sym, by_grp = {}, {}
        for _, s, v, _ in self.legs(px):
            by_sym[s] = by_sym.get(s, 0.0) + v
            by_grp[group_of(s)] = by_grp.get(group_of(s), 0.0) + v
        return by_sym, by_grp

    def room(self, inst, side, unit_px, eq, px):
        """$ of new exposure in this direction the fund can still take in inst. Returns (room, why it's limited)."""
        s = inst["sym"]
        g = group_of(s)
        by_sym, by_grp = self.exposure(px)
        have_s, have_g = max(0.0, side * by_sym.get(s, 0.0)), max(0.0, side * by_grp.get(g, 0.0))
        r_s, r_g = C.MAX_SYM_NOTIONAL * eq - have_s, C.MAX_GROUP_NOTIONAL * eq - have_g
        room = min(r_s, r_g)
        if inst["cls"] == "futures" and have_g <= 0:
            room = max(room, unit_px * inst["pv"])     # one micro contract is the smallest bet: allowed alone in its group
        why = (f"{s} is already {have_s / eq:.0%} of the fund (limit {C.MAX_SYM_NOTIONAL:.0%})" if r_s <= r_g
               else f"{g} are already {have_g / eq:.0%} of the fund (limit {C.MAX_GROUP_NOTIONAL:.0%})")
        return max(0.0, room), why

    async def enforce(self):
        """Trim the book back under the limits, pro rata across the pods holding the crowded market or group."""
        f = self.f
        px = f.prices()
        eq = f.broker.equity(px)
        if eq <= 0:
            return
        for level in ("sym", "grp"):
            by_sym, by_grp = self.exposure(px)
            book, lim = (by_sym, C.MAX_SYM_NOTIONAL) if level == "sym" else (by_grp, C.MAX_GROUP_NOTIONAL)
            cap = lim * eq
            for name, net in list(book.items()):
                if abs(net) <= cap * (1 + TRIM_SLACK):
                    continue
                side = 1 if net > 0 else -1
                mine = [(k, v) for _, s, v, k in self.legs(px) if k and v * side > 0 and (s if level == "sym" else group_of(s)) == name]
                if mine and all(C.INST[f.broker.positions[k]["sym"]]["cls"] == "futures" for k, _ in mine):
                    # futures only: one micro contract is the smallest bet and may exceed the cap alone (same rule as room())
                    one = max(px.get(f.broker.positions[k]["sym"], 0) * C.INST[f.broker.positions[k]["sym"]]["pv"] for k, _ in mine)
                    if abs(net) <= max(cap, one) * (1 + TRIM_SLACK):
                        continue
                    cap_n = max(cap, one)
                else:
                    cap_n = cap
                pods = sorted({f.names.get(f.broker.positions[k]["pod"], "?") for k, _ in mine})
                what = f"{name} is {abs(net) / eq:.0%} of the fund" if level == "sym" else f"{name} are {abs(net) / eq:.0%} of the fund"
                live = [(k, v) for k, v in mine if f.desk.is_open(f.broker.positions[k]["sym"]) and px.get(f.broker.positions[k]["sym"])]
                if not live:
                    day = time.strftime("%Y-%m-%d")
                    if self.warned.get(f"{level}:{name}") != day:
                        self.warned[f"{level}:{name}"] = day
                        await f.say("rex", "risk", f"Crowded: {what} ({', '.join(pods)}; limit {lim:.0%}). I'll trim it at the open.", pause=2, ok=False)
                    continue
                excess = abs(net) - cap_n
                frac = min(1.0, excess / max(sum(abs(v) for _, v in mine), 1e-9))   # every leg's fair share; closed markets wait for the open
                await f.say("rex", "risk", f"Crowded: {what} ({', '.join(pods)}; limit {lim:.0%}). Trimming every pod in it by {frac:.0%}.",
                            pause=2.5, ok=False)
                left = excess * sum(abs(v) for _, v in live) / max(sum(abs(v) for _, v in mine), 1e-9)   # the open markets' share
                for k, _ in sorted(live, key=lambda kv: -abs(kv[1])):
                    p = f.broker.positions.get(k)
                    if not p or left <= 0:
                        continue
                    step, unit = C.INST[p["sym"]]["step"], px[p["sym"]] * C.INST[p["sym"]]["pv"]
                    cut = math.ceil(p["qty"] * frac / step - 1e-9) * step
                    cut = min(cut, math.ceil(left / unit / step - 1e-9) * step)    # whole contracts: stop once the excess is covered
                    if p["qty"] - cut < step * 0.999:
                        cut = p["qty"]
                    if cut > 0:
                        left -= cut * unit
                        await f.trim(k, round(cut, 8), px[p["sym"]], "risk limit: crowded " + name)
                px = f.prices()
                eq = f.broker.equity(px)

    def snapshot(self, px, eq):
        by_sym, by_grp = self.exposure(px)
        pods: dict = {}
        for pod, s, v, _ in self.legs(px):
            pods.setdefault(s, []).append(self.f.names.get(pod, pod))
        eq = eq or 1.0
        return dict(sym_cap=C.MAX_SYM_NOTIONAL, grp_cap=C.MAX_GROUP_NOTIONAL,
                    syms=sorted(([s, v / eq, sorted(set(pods.get(s, [])))] for s, v in by_sym.items() if abs(v) > 1), key=lambda x: -abs(x[1])),
                    groups=sorted(([g, v / eq, [s for s in C.RISK_GROUPS.get(g, [g]) if abs(by_sym.get(s, 0)) > 1]] for g, v in by_grp.items() if abs(v) > 1),
                                  key=lambda x: -abs(x[1])))
