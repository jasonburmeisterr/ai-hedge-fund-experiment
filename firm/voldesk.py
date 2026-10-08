"""Opal's ETF options book: iron condors on US ETFs, only where the Vol Lab validated an edge.

The rule comes from the Model Lab's volatility models (firm/quant/vol.py): sell when the option chain's implied vol is
rich versus the HAR forecast of realized vol (IV / forecast >= the k chosen on the development years), or, for
"premium-only" underlyings, whenever implied is above the forecast. Structure: ~35 days out, short ~20-delta call and
put, long ~7-delta wings (defined risk). Sized to Opal's risk budget times the CIO's multiplier. Managed with the same
rules as the backtest: take profit at 50% of the credit, stop at a loss of 1.5x the credit, close 2 days before expiry.
Live Alpaca quotes (indicative feed); fills at the natural side (sell at the bid, buy at the ask) plus fees.

Futures options (CME) aren't available: Alpaca has no futures, and CME options data isn't free. That needs an
Interactive Brokers account or paid CME data."""
import datetime as dt
import time

from . import config as C
from .stockopts import MULT, FEE_PER_CONTRACT
from .quant.ivdata import IV_SYMS

SYMS = [s for s in IV_SYMS if C.INST.get(s, {}).get("cls") in ("etf", "stock")]
TARGET_DTE, SHORT_D, WING_D = 35, 0.20, 0.07
TP, SL, CLOSE_DTE = 0.5, 1.5, 2
TRY_EVERY = 3600


class ETFVolDesk:
    def __init__(self, floor):
        self.f = floor
        self.tried: dict = {}
        self.last: dict = {}           # sym -> last decision text (for the dashboard)

    def mine(self):
        return {k: s for k, s in self.f.broker.opt.items() if s.get("venue") == "alpaca" and s.get("expr") == "condor"}

    async def plan(self, sym, budget=None):
        """Build (but don't trade) the condor this desk would sell now: short ~20-delta call and put; the wings are the widest
        symmetric pair (out to ~7 delta) whose max loss fits the budget. Returns (spec, why_not)."""
        so = self.f.sopt
        calls, puts = await so.chain(sym, "C"), await so.chain(sym, "P")
        if not calls or not puts:
            return None, "no liquid option quotes"
        want = time.time() + TARGET_DTE * 86400
        exps = sorted({l["exp"] for l in calls} & {l["exp"] for l in puts}, key=lambda e: abs(e - want))
        smallest = None
        for exp in exps[:3]:
            cs, ps = [l for l in calls if l["exp"] == exp], [l for l in puts if l["exp"] == exp]
            sc = min(cs, key=lambda l: abs(l["delta"] - SHORT_D))
            sp = min(ps, key=lambda l: abs(l["delta"] - SHORT_D))
            far_c = min([l for l in cs if l["strike"] > sc["strike"]] or [sc], key=lambda l: abs(l["delta"] - WING_D))["strike"] - sc["strike"]
            far_p = sp["strike"] - min([l for l in ps if l["strike"] < sp["strike"]] or [sp], key=lambda l: abs(l["delta"] - WING_D))["strike"]
            widths = sorted({round(l["strike"] - sc["strike"], 2) for l in cs if 0 < l["strike"] - sc["strike"] <= max(far_c, far_p)}, reverse=True)
            for w in widths:                                          # widest first, down to one strike
                lc = min((l for l in cs if l["strike"] > sc["strike"]), key=lambda l: abs(l["strike"] - sc["strike"] - w))
                lp = min((l for l in ps if l["strike"] < sp["strike"]), key=lambda l: abs(sp["strike"] - l["strike"] - w), default=None)
                if lp is None:
                    continue
                credit = sc["bid"] + sp["bid"] - lc["ask"] - lp["ask"]
                width = max(lc["strike"] - sc["strike"], sp["strike"] - lp["strike"])
                if credit <= 0 or credit < 0.12 * width:
                    continue
                loss = (width - credit) * MULT + 4 * FEE_PER_CONTRACT
                smallest = loss if smallest is None else min(smallest, loss)
                if budget is not None and loss > budget:
                    continue
                atm = [l for l in cs + ps if l.get("iv") and 0.4 <= l["delta"] <= 0.6]
                ivs = [l["iv"] for l in (sc, sp) if l.get("iv")]
                iv = sum(l["iv"] for l in atm) / len(atm) if atm else (sum(ivs) / len(ivs) if ivs else None)
                return dict(sc=sc, lc=lc, sp=sp, lp=lp, credit=credit, width=width, exp=exp, iv=iv), None
        if smallest is not None and budget is not None:
            return None, f"the smallest condor risks ${smallest:,.0f}; Opal's budget is ${budget:,.0f}"
        return None, "no condor with a sane credit"

    async def step(self):
        f = self.f
        so = f.sopt
        if not so.configured:
            return
        for k, stx in list(self.mine().items()):      # manage (marks come from the stock-options desk's quote loop)
            if not f.desk.is_open(stx["cur"]):
                continue
            upl = f.broker.opt_upl(k)
            dte = (stx["legs"][0]["exp"] - time.time()) / 86400
            reason = ("took 50% of the credit" if upl >= TP * stx["credit"] else "condor stop (1.5x the credit)" if -upl >= SL * stx["credit"]
                      else "closing before expiry" if dte <= CLOSE_DTE else None)
            if reason:
                await so.close(k, reason)
        if "opal" in f.inactive() or f.cio.paused():
            return
        held = {s["cur"] for s in self.mine().values()}
        for sym in SYMS:
            if sym in held or not f.desk.is_open(sym) or time.time() - self.tried.get(sym, 0) < TRY_EVERY:
                continue
            rule = f.mlab.vol_rule(sym)
            if not rule or rule["tier"] == "none" or not rule.get("fc"):
                self.last[sym] = "no validated volatility edge: standing aside"
                continue
            self.tried[sym] = time.time()
            budget = f._risk_cash() * f.cio.fund()["mult"]
            try:
                spec, why = await self.plan(sym, budget)
            except Exception as e:
                spec, why = None, f"options data error ({type(e).__name__})"
            if not spec or not spec.get("iv"):
                self.last[sym] = why or "no implied vol in the chain"
                continue
            ratio = spec["iv"] / rule["fc"]
            if ratio < rule["k"]:
                self.last[sym] = f"IV {spec['iv']:.0%} vs forecast {rule['fc']:.0%} = {ratio:.2f}, below the {rule['k']:.1f} the model needs"
                continue
            await self.open(sym, spec, rule, ratio)

    async def open(self, sym, spec, rule, ratio):
        f = self.f
        okc, cwhy = f.compliance.check("opal", sym, 0)
        if not okc:
            self.last[sym] = "blocked by compliance: " + cwhy
            return
        F = f.cio.fund()
        per = (spec["width"] - spec["credit"]) * MULT + 4 * FEE_PER_CONTRACT
        risk = f._risk_cash() * F["mult"]
        qty = int(risk // per)
        if qty < 1:
            self.last[sym] = f"one condor risks ${per:,.0f}; Opal's budget is ${risk:,.0f}"
            return
        sc, lc, sp, lp = spec["sc"], spec["lc"], spec["sp"], spec["lp"]
        exp_txt = dt.datetime.fromtimestamp(spec["exp"]).strftime("%b %d")
        await f.say("opal", "signal", f"{sym} implied vol {spec['iv']:.0%} vs the HAR forecast {rule['fc']:.0%} ({ratio:.2f}x, model needs "
                    f"{rule['k']:.1f}x). Selling a {exp_txt} iron condor {sp['strike']:g}/{sc['strike']:g}.", pause=3, sym=sym, dir=0)
        at = "" if abs(F["mult"] - 1) < 0.05 else f" at {F['mult']:.2g}x"
        await f.say("boss", "decision", f"Opal: approved{at}. Defined risk, validated model. Rex, size it.", pause=2, sym=sym, act="trade")
        legs = [dict(name=l["name"], kind=l["kind"], strike=l["strike"], exp=l["exp"], side=side, qty=qty,
                     px=(l["bid"] if side < 0 else l["ask"]) * MULT, fee=FEE_PER_CONTRACT * qty) for l, side in ((sc, -1), (lc, 1), (sp, -1), (lp, 1))]
        max_loss = per * qty
        await f.say("rex", "risk", f"APPROVED: {qty} x {sym} iron condor for Opal. Max loss ${max_loss:,.0f} (defined risk).", pause=2, sym=sym, ok=True, target="opal")
        key, fees = f.broker.open_opt("opal", sym, legs, max_loss, "iron condor")
        f.broker.opt[key].update(venue="alpaca", dir=0, stop=None, opened_px=f.desk.price(sym), expr="condor", model_ratio=round(ratio, 3))
        for leg, l in zip(f.broker.opt[key]["legs"], (sc, lc, sp, lp)):
            leg["iv"] = l.get("iv")
            f.broker.opt_marks[l["name"]] = l["mid"] * MULT
        f.cio.log("opal", sym, 0, F["mult"], [f"{sym} IV/forecast {ratio:.2f} >= {rule['k']:.1f} ({rule['tier']})"], "APPROVED", key)
        await f.say("eddie", "fill", f"FILLED {qty} {sym} iron condors for Opal: credit ${spec['credit'] * MULT * qty:,.0f}, max loss ${max_loss:,.0f}.", pause=1, sym=sym)
        self.last[sym] = f"sold {qty} condors at IV/forecast {ratio:.2f}"
        await f.sopt.mirror(key, opening=True)

    def snapshot(self):
        return dict(syms=SYMS, last=self.last, open=len(self.mine()),
                    note="Futures options need an Interactive Brokers account or paid CME data: not available on Alpaca.")
