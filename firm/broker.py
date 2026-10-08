"""Paper prime broker: fills orders at the live price plus slippage and commission, and tracks P&L.
Positions belong to a POD (a portfolio manager), keyed "pod|SYM", so several pods can hold the same market.
No real money is ever touched."""
import time

from .config import INST, STARTING_CASH


def fee(inst, qty, px):
    if "fee_per" in inst:
        return inst["fee_per"] * qty
    return inst["fee_pct"] * qty * px


def pos_key(pod, sym):
    return f"{pod}|{sym}"


class Broker:
    def __init__(self, state: dict | None = None):
        s = state or {}
        self.cash = s.get("cash", STARTING_CASH)
        self.positions: dict[str, dict] = {}
        for k, p in s.get("positions", {}).items():   # migrate old saves (keyed by symbol only)
            p.setdefault("sym", k.split("|")[-1])
            p.setdefault("pod", k.split("|")[0] if "|" in k else "legacy")
            self.positions[pos_key(p["pod"], p["sym"])] = p
        self.trades: list[dict] = s.get("trades", [])
        self.fees_paid = s.get("fees_paid", 0.0)
        self.opt: dict[str, dict] = s.get("opt", {})        # option structures: key -> {pod, cur, legs, ...}
        self.opt_marks: dict[str, float] = {}                # latest USD mark per option instrument
        self.realized: dict = s.get("realized") or {}        # pod -> realized P&L since inception (survives trimming the trade list)
        if not s.get("realized"):
            for t in self.trades:
                self.realized[t.get("pod")] = self.realized.get(t.get("pod"), 0.0) + t["pnl"]
        self.interest_paid = s.get("interest_paid", 0.0)     # margin interest on borrowed cash (negative cash)
        self.accrued_t = s.get("accrued_t", time.time())

    def to_state(self):
        return dict(cash=self.cash, positions=self.positions, trades=self.trades[-1000:], fees_paid=self.fees_paid, opt=self.opt,
                    interest_paid=self.interest_paid, accrued_t=self.accrued_t, realized=self.realized)

    def _book(self, trade):
        self.realized[trade["pod"]] = self.realized.get(trade["pod"], 0.0) + trade["pnl"]
        self.trades.append(trade)
        if len(self.trades) > 3000:
            del self.trades[:-2000]

    # ── margin ──
    def cash_notional(self, prices) -> float:
        """Value of everything owned outright (stocks, ETFs, crypto): what MAX_GROSS limits."""
        return sum(prices.get(p["sym"], p["entry"]) * p["qty"] for p in self.positions.values() if INST[p["sym"]]["cls"] != "futures")

    def accrue_interest(self, rate, now=None) -> float:
        """Charge interest on borrowed cash (negative cash balance) since the last call."""
        now = now or time.time()
        dt = max(0.0, now - self.accrued_t)
        self.accrued_t = now
        if self.cash >= 0 or dt <= 0:
            return 0.0
        charge = -self.cash * rate * dt / (365 * 86400)
        self.cash -= charge
        self.interest_paid += charge
        return charge

    # ── options ──
    def opt_value(self, key) -> float:
        """Mark-to-market value of a structure (long legs positive, short legs negative)."""
        return sum(l["side"] * l["qty"] * self.opt_marks.get(l["name"], l["entry"]) for l in self.opt[key]["legs"])

    def opt_upl(self, key) -> float:
        return sum(l["side"] * l["qty"] * (self.opt_marks.get(l["name"], l["entry"]) - l["entry"]) for l in self.opt[key]["legs"])

    def open_opt(self, pod, cur, legs, max_loss, kind):
        """legs: [{name, kind, strike, exp, side, qty, px, fee}] with px = fill price in USD."""
        key = f"{pod}|{cur}|{time.time_ns()}"
        fees = sum(l["fee"] for l in legs)
        self.cash -= sum(l["side"] * l["qty"] * l["px"] for l in legs) + fees
        self.fees_paid += fees
        self.opt[key] = dict(pod=pod, cur=cur, kind=kind, opened=time.time(), max_loss=max_loss, fees=fees,
                             credit=-sum(l["side"] * l["qty"] * l["px"] for l in legs),
                             legs=[dict(name=l["name"], kind=l["kind"], strike=l["strike"], exp=l["exp"], side=l["side"],
                                        qty=l["qty"], entry=l["px"]) for l in legs])
        return key, fees

    def close_opt(self, key, exits: dict, fees: float, reason):
        """exits: {leg name: exit price USD}."""
        st = self.opt.pop(key)
        self.cash += sum(l["side"] * l["qty"] * exits[l["name"]] for l in st["legs"]) - fees
        self.fees_paid += fees
        pnl = sum(l["side"] * l["qty"] * (exits[l["name"]] - l["entry"]) for l in st["legs"]) - fees - st["fees"]
        trade = dict(sym=f"{st['cur']} {st['kind']}", pod=st["pod"], side=0, qty=st["legs"][0]["qty"], entry=st["credit"],
                     exit=0.0, pnl=pnl, reason=reason, why="options", opened=st["opened"], closed=time.time(),
                     ret=pnl / max(st["max_loss"], 1e-9))
        self._book(trade)
        return trade

    # ── valuation ──
    def upl(self, key, px):
        p = self.positions[key]
        return (px - p["entry"]) * p["qty"] * INST[p["sym"]]["pv"] * p["side"]

    def equity(self, prices: dict) -> float:
        eq = self.cash
        for key, p in self.positions.items():
            px = prices.get(p["sym"], p["entry"])
            if INST[p["sym"]]["cls"] == "futures":
                eq += self.upl(key, px)
            else:  # cash assets are owned outright (long only)
                eq += px * p["qty"]
        return eq + sum(self.opt_value(k) for k in self.opt)

    def open_risk(self) -> float:
        """$ lost if every stop got hit right now (0 for stops already past entry)."""
        return sum(max((p["entry"] - p["stop"]) * p["side"], 0) * p["qty"] * INST[p["sym"]]["pv"]
                   for p in self.positions.values()) + sum(st["max_loss"] for st in self.opt.values())

    def futures_notional(self, prices) -> float:
        return sum(prices.get(p["sym"], p["entry"]) * p["qty"] * INST[p["sym"]]["pv"]
                   for p in self.positions.values() if INST[p["sym"]]["cls"] == "futures")

    def exposure(self, prices) -> dict:
        gross = net = 0.0
        by_cls: dict = {}
        for p in self.positions.values():
            notional = prices.get(p["sym"], p["entry"]) * p["qty"] * INST[p["sym"]]["pv"]
            gross += notional
            net += notional * p["side"]
            c = INST[p["sym"]]["cls"]
            by_cls[c] = by_cls.get(c, 0.0) + notional * p["side"]
        return dict(gross=gross, net=net, by_cls=by_cls)

    def pod_pnl(self, pod, prices) -> float:
        realized = self.realized.get(pod, 0.0)
        unreal = sum(self.upl(k, prices.get(p["sym"], p["entry"])) for k, p in self.positions.items() if p["pod"] == pod)
        unreal += sum(self.opt_upl(k) - st["fees"] for k, st in self.opt.items() if st["pod"] == pod)
        return realized + unreal

    # ── orders ──
    def open(self, pod, sym, side, qty, px, stop, why):
        inst = INST[sym]
        fill = px * (1 + inst["slip_pct"] * side)
        f = fee(inst, qty, fill)
        if inst["cls"] == "futures":
            self.cash -= f
        else:
            self.cash -= fill * qty + f
        self.fees_paid += f
        key = pos_key(pod, sym)
        self.positions[key] = dict(sym=sym, pod=pod, side=side, qty=qty, entry=fill, stop=stop, best=fill,
                                   opened=time.time(), bars=0, why=why)
        return key, fill, f

    def close(self, key, px, reason):
        p = self.positions.pop(key)
        inst = INST[p["sym"]]
        fill = px * (1 - inst["slip_pct"] * p["side"])
        f = fee(inst, p["qty"], fill)
        gross = (fill - p["entry"]) * p["qty"] * inst["pv"] * p["side"]
        if inst["cls"] == "futures":
            self.cash += gross - f
        else:
            self.cash += fill * p["qty"] - f
        self.fees_paid += f
        pnl = gross - f - fee(inst, p["qty"], p["entry"])   # net of both commissions
        trade = dict(sym=p["sym"], pod=p["pod"], side=p["side"], qty=p["qty"], entry=p["entry"], exit=fill,
                     pnl=pnl, reason=reason, why=p.get("why", ""), opened=p["opened"], closed=time.time())
        self._book(trade)
        return trade

    def reduce(self, key, qty, px, reason):
        """Close part of a position (the rest stays open with the same entry and stop). Returns the trade for the part sold."""
        p = self.positions[key]
        if qty >= p["qty"] - 1e-12:
            return self.close(key, px, reason)
        left = round(p["qty"] - qty, 8)
        self.positions[key] = dict(p, qty=qty)
        trade = self.close(key, px, reason)
        rest = dict(p, qty=left)
        if rest.get("risk0"):
            rest["risk0"] = p["risk0"] * left / p["qty"]
        self.positions[key] = rest
        return trade
