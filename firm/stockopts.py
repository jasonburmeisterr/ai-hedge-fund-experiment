"""Stock & ETF options for every PM (Alpaca data, defined risk only).

When a daily PM's signal fires on an optionable US ETF/stock, the PM chooses HOW to express it:
  - shares (the classic way), or
  - a DEBIT VERTICAL SPREAD: buy a ~0.55-delta call (put for shorts), sell a ~0.25-delta call (put), 25-60 days out.
    Max loss = the debit paid, sized to the same risk budget the shares trade would have used. No naked selling.
Which one each PM uses is TRIAL AND ERROR on live paper results: every closed trade is scored in R (P&L / risk taken),
per PM and per expression. Until both have MIN_TRIES results the PM alternates; after that it picks with Thompson
sampling, so PMs drift toward whatever has actually worked for them. (No free historical options data exists, so this
is learned forward, like Opal's desk.)

Exits: the PM's own stop level on the underlying, the PM's signal flipping, 80% of max value captured, 7 days to expiry,
or the PM's holding-period limit. Fills use the natural side of real Alpaca quotes (buy at ask, sell at bid) plus fees.
If the Alpaca broker link is on, each spread is also sent to the Alpaca PAPER account as a multi-leg order
(best effort; the floor's ledger stays the source of truth)."""
import asyncio
import datetime as dt
import math
import random
import re
import time

import httpx

from . import config as C

DATA = "https://data.alpaca.markets/v1beta1/options"
MULT = 100
FEE_PER_CONTRACT = 0.05            # regulatory/clearing fees per contract per side (Alpaca: $0 commission)
MIN_TRIES = 4
LONG_DELTA, SHORT_DELTA = 0.55, 0.25
DTE_MIN, DTE_MAX = 25, 60
TAKE_PROFIT = 0.80                 # close when the spread is worth 80% of its max value
CLOSE_DTE = 7
MAX_QUOTE_SPREAD = 0.25            # skip legs whose bid/ask spread is > 25% of mid
MARK_EVERY_SEC = 120
OCC = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")


def optionable(sym):
    return C.INST.get(sym, {}).get("cls") in ("etf", "stock")


def parse_occ(s):
    m = OCC.match(s)
    if not m:
        return None
    root, ymd, cp, k = m.groups()
    exp = dt.datetime.strptime(ymd, "%y%m%d").replace(hour=20, tzinfo=dt.timezone.utc)   # 4pm ET close
    return dict(root=root, exp=exp.timestamp(), kind=cp, strike=int(k) / 1000)


class StockOptions:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.on: bool = st.get("on", True)
        self.results: dict = st.get("results", {})      # pod -> {"shares": [R...], "spread": [R...]}
        self.turn: dict = st.get("turn", {})            # pod -> last expression used while exploring
        self.errors: list = []
        self.last_mark = 0.0
        self.mirror_log: list = st.get("mirror_log", [])

    def to_state(self):
        return dict(on=self.on, results={k: {e: v[-60:] for e, v in d.items()} for k, d in self.results.items()},
                    turn=self.turn, mirror_log=self.mirror_log[-30:])

    @property
    def configured(self):
        return bool(C.ALPACA_KEY and C.ALPACA_SECRET)

    def _headers(self):
        return {"APCA-API-KEY-ID": C.ALPACA_KEY, "APCA-API-SECRET-KEY": C.ALPACA_SECRET}

    # ── the learned choice: shares or a spread ──
    def choose(self, pod):
        r = self.results.get(pod, {})
        sh, sp = r.get("shares", []), r.get("spread", [])
        if len(sh) < MIN_TRIES or len(sp) < MIN_TRIES:
            nxt = "spread" if self.turn.get(pod) != "spread" else "shares"
            if len(sp) >= MIN_TRIES:
                nxt = "shares"
            elif len(sh) >= MIN_TRIES:
                nxt = "spread"
            return nxt, "exploring"

        def draw(x):
            m = sum(x) / len(x)
            sd = (sum((v - m) ** 2 for v in x) / max(1, len(x) - 1)) ** 0.5 or 1.0
            return random.gauss(m, sd / math.sqrt(len(x)))
        return ("spread" if draw(sp) > draw(sh) else "shares"), "learned"

    def record(self, pod, expr, r_mult):
        self.results.setdefault(pod, {}).setdefault(expr, []).append(round(float(r_mult), 3))

    def stats(self, pod):
        r = self.results.get(pod, {})
        out = {}
        for e in ("shares", "spread"):
            x = r.get(e, [])
            out[e] = dict(n=len(x), avg_r=round(sum(x) / len(x), 2) if x else None, win=round(sum(v > 0 for v in x) / len(x), 2) if x else None)
        return out

    # ── market data ──
    async def chain(self, sym, kind):
        lo = (dt.date.today() + dt.timedelta(days=DTE_MIN)).isoformat()
        hi = (dt.date.today() + dt.timedelta(days=DTE_MAX)).isoformat()
        async with httpx.AsyncClient(timeout=20, headers=self._headers()) as cl:
            r = await cl.get(f"{DATA}/snapshots/{sym}", params=dict(feed="indicative", type="call" if kind == "C" else "put",
                                                                   expiration_date_gte=lo, expiration_date_lte=hi, limit=1000))
            r.raise_for_status()
            out = []
            for name, s in (r.json().get("snapshots") or {}).items():
                q, g, p = s.get("latestQuote") or {}, s.get("greeks") or {}, parse_occ(name)
                if not p or not q.get("ap") or not q.get("bp") or g.get("delta") is None:
                    continue
                mid = (q["ap"] + q["bp"]) / 2
                if mid <= 0 or (q["ap"] - q["bp"]) / mid > MAX_QUOTE_SPREAD:
                    continue
                out.append(dict(name=name, bid=q["bp"], ask=q["ap"], mid=mid, delta=abs(g["delta"]), iv=s.get("impliedVolatility"), **p))
            return out

    async def quotes(self, names):
        out = {}
        async with httpx.AsyncClient(timeout=20, headers=self._headers()) as cl:
            for i in range(0, len(names), 50):
                r = await cl.get(f"{DATA}/snapshots", params=dict(symbols=",".join(names[i:i + 50]), feed="indicative"))
                r.raise_for_status()
                for name, s in (r.json().get("snapshots") or {}).items():
                    q = s.get("latestQuote") or {}
                    if q.get("bp") is not None and q.get("ap"):
                        out[name] = dict(bid=q["bp"], ask=q["ap"], mid=(q["bp"] + q["ap"]) / 2)
        return out

    async def build(self, sym, d, hold_days):
        """Pick a debit vertical: same expiry, long ~0.55 delta, short ~0.25 delta, in the direction d."""
        kind = "C" if d > 0 else "P"
        legs = await self.chain(sym, kind)
        if not legs:
            return None, "no liquid options quotes"
        want = time.time() + max(DTE_MIN, min(DTE_MAX, hold_days * 1.4)) * 86400
        exps = sorted({l["exp"] for l in legs}, key=lambda e: abs(e - want))
        for exp in exps[:3]:
            strip = [l for l in legs if l["exp"] == exp]
            lg = min(strip, key=lambda l: abs(l["delta"] - LONG_DELTA))
            sh = min(strip, key=lambda l: abs(l["delta"] - SHORT_DELTA))
            if lg["name"] == sh["name"] or (sh["strike"] - lg["strike"]) * d <= 0:
                continue
            width = abs(sh["strike"] - lg["strike"])
            debit = lg["ask"] - sh["bid"]
            if debit <= 0 or debit >= 0.75 * width:
                continue
            return dict(long=lg, short=sh, debit=debit, width=width, exp=exp, kind=kind), None
        return None, "no spread with a sane price"

    # ── opening ──
    async def open(self, a, inst, d, px, atr, risk_cash, stop):
        f = self.floor
        s, pod, name = inst["sym"], a["id"], a["name"]
        try:
            spec, why = await self.build(s, d, a["params"].get("max_bars", 20))
        except Exception as e:
            spec, why = None, f"options data error ({type(e).__name__})"
        if not spec:
            return False, why
        per = spec["debit"] * MULT + 2 * FEE_PER_CONTRACT
        qty = int(risk_cash // per)
        if qty < 1:
            return False, f"one spread risks ${per:,.0f}, budget is ${risk_cash:,.0f}"
        lg, sh = spec["long"], spec["short"]
        kind = f"{'call' if d > 0 else 'put'} spread {lg['strike']:g}/{sh['strike']:g}"
        legs = [dict(name=lg["name"], kind=lg["kind"], strike=lg["strike"], exp=lg["exp"], side=1, qty=qty, px=lg["ask"] * MULT, fee=FEE_PER_CONTRACT * qty),
                dict(name=sh["name"], kind=sh["kind"], strike=sh["strike"], exp=sh["exp"], side=-1, qty=qty, px=sh["bid"] * MULT, fee=FEE_PER_CONTRACT * qty)]
        max_loss = per * qty
        await f.say("rex", "risk", f"APPROVED: {qty} x {s} {kind} for {name}. Max loss ${max_loss:,.0f} (defined risk).", pause=2.5, sym=s, ok=True, target=pod)
        await f.say("eddie", "order", f"Routing {name}'s {s} {kind} ({dt.datetime.fromtimestamp(spec['exp']).strftime('%b %d')} expiry, 2 legs)...", pause=3.5, sym=s, dir=d)
        key, fees = f.broker.open_opt(pod, s, legs, max_loss, kind)
        f.broker.opt[key].update(venue="alpaca", dir=d, stop=stop, opened_px=px, max_value=spec["width"] * MULT * qty,
                                 hold_days=a["params"].get("max_bars", 20), expr="spread")
        for l in legs:
            f.broker.opt_marks[l["name"]] = l["px"] if l["side"] > 0 else l["px"]
        await f.say("eddie", "fill", f"FILLED {qty} {s} {kind} for {name}: debit ${spec['debit']:.2f}/share, max gain "
                    f"${(spec['width'] - spec['debit']) * MULT * qty:,.0f}, max loss ${max_loss:,.0f}", pause=1.0, sym=s)
        await self.mirror(key, opening=True)
        return True, ""

    # ── marking + exits ──
    def mine(self):
        return {k: s for k, s in self.floor.broker.opt.items() if s.get("venue") == "alpaca"}

    async def manage(self):
        f = self.floor
        book = self.mine()
        if not book or not self.configured:
            return
        if time.time() - self.last_mark > MARK_EVERY_SEC:
            self.last_mark = time.time()
            try:
                q = await self.quotes(sorted({l["name"] for s in book.values() for l in s["legs"]}))
                for n, v in q.items():
                    f.broker.opt_marks[n] = v["mid"] * MULT
                self._q = q
            except Exception as e:
                self.errors = (self.errors + [f"{type(e).__name__}: {e}"[:120]])[-5:]
                return
        for k, stx in list(book.items()):
            s = stx["cur"]
            if stx.get("expr") == "condor" or not f.desk.is_open(s):       # condors belong to Opal's ETF vol desk (firm/voldesk.py)
                continue
            px = f.desk.price(s)
            dte = (stx["legs"][0]["exp"] - time.time()) / 86400
            value = f.broker.opt_value(k)
            held = (time.time() - stx["opened"]) / 86400
            reason = None
            if px and (px - stx["stop"]) * stx["dir"] <= 0:
                reason = "underlying hit the PM's stop"
            elif value >= TAKE_PROFIT * stx["max_value"]:
                reason = f"captured {TAKE_PROFIT:.0%} of max value"
            elif dte <= CLOSE_DTE:
                reason = "closing before expiry"
            elif held > stx.get("hold_days", 20) * 1.45:
                reason = "holding-period limit"
            if reason:
                await self.close(k, reason)

    async def close(self, key, reason):
        f = self.floor
        stx = f.broker.opt[key]
        q = getattr(self, "_q", {})
        exits = {}
        for l in stx["legs"]:
            v = q.get(l["name"])
            if v:
                exits[l["name"]] = (v["bid"] if l["side"] > 0 else v["ask"]) * MULT
            else:   # no quote: settle at intrinsic value using the underlying price
                S = f.desk.price(stx["cur"]) or stx["opened_px"]
                exits[l["name"]] = max(0.0, (S - l["strike"]) if l["kind"] == "C" else (l["strike"] - S)) * MULT
        name = f.names.get(stx["pod"], stx["pod"])
        await f.say("eddie", "order", f"Closing {name}'s {stx['cur']} {stx['kind']} ({reason})...", pause=3.0, sym=stx["cur"], dir=0)
        await self.mirror(key, opening=False)
        tr = f.broker.close_opt(key, exits, FEE_PER_CONTRACT * sum(l["qty"] for l in stx["legs"]), reason)
        self.record(stx["pod"], "spread", tr["pnl"] / max(stx["max_loss"], 1e-9))
        await f.say("eddie", "close", f"CLOSED {name}'s {tr['sym']}: {'+' if tr['pnl'] >= 0 else '-'}${abs(tr['pnl']):,.2f}",
                    pause=1.0, sym=stx["cur"], pnl=tr["pnl"], pod=stx["pod"])
        await f.minds.on_trade({**tr, "pod": stx["pod"], "sym": f"{stx['cur']} {stx['kind']}"})
        await self._lesson(stx["pod"])

    async def _lesson(self, pod):
        st = self.stats(pod)
        sh, sp = st["shares"], st["spread"]
        if sh["n"] >= MIN_TRIES and sp["n"] >= MIN_TRIES and (sh["n"] + sp["n"]) % 4 == 0:
            better = "spreads" if sp["avg_r"] > sh["avg_r"] else "shares"
            await self.floor.minds.remember(pod, "options", f"So far {better} work better for me (spreads {sp['avg_r']:+.2f}R over {sp['n']}, "
                                            f"shares {sh['avg_r']:+.2f}R over {sh['n']}).", xp=5)

    async def flip(self, pod, sym, d):
        """The PM's signal reversed: close any spread on that market pointing the other way."""
        for k, stx in list(self.mine().items()):
            if stx["pod"] == pod and stx["cur"] == sym and stx["dir"] != d:
                await self.close(k, "signal reversed")

    def has(self, pod, sym):
        return any(stx["pod"] == pod and stx["cur"] == sym for stx in self.mine().values())

    # ── optional mirror to the Alpaca PAPER account ──
    async def mirror(self, key, opening):
        f = self.floor
        al = f.alpaca
        if not (al.configured and al.enabled and not al.killed) or al.live:     # never send options to a LIVE account from here
            return
        stx = f.broker.opt[key]
        scale = (al.account.get("equity") or 0) / max(1.0, f.broker.equity(f.prices()))
        qty = int(stx["legs"][0]["qty"] * scale)
        if qty < 1:
            return
        legs = [dict(symbol=l["name"], ratio_qty="1", side=("buy" if l["side"] > 0 else "sell") if opening else ("sell" if l["side"] > 0 else "buy"),
                     position_intent=("buy_to_open" if l["side"] > 0 else "sell_to_open") if opening else ("sell_to_close" if l["side"] > 0 else "buy_to_close"))
                for l in stx["legs"]]
        body = dict(order_class="mleg", qty=str(qty), type="market", time_in_force="day", legs=legs)
        try:
            async with al._client() as cl:
                r = await cl.post("/v2/orders", json=body)
            ok = r.status_code < 300
            msg = f"{'opened' if opening else 'closed'} {qty} {stx['cur']} {stx['kind']} on Alpaca paper" if ok else f"Alpaca rejected the spread: {r.text[:120]}"
        except Exception as e:
            ok, msg = False, f"Alpaca options order failed: {type(e).__name__}"
        self.mirror_log = (self.mirror_log + [dict(t=time.time(), ok=ok, msg=msg)])[-30:]
        await f.say("eddie", "order" if ok else "risk", msg, pause=1.0, ok=ok)

    def snapshot(self):
        f = self.floor
        return dict(on=self.on, configured=self.configured, errors=self.errors[-3:], mirror=self.mirror_log[-5:],
                    pods={a["id"]: self.stats(a["id"]) for a in f.roster if a["family"] != "options"},
                    open=[dict(key=k, pod=s["pod"], sym=s["cur"], kind=s["kind"], max_loss=s["max_loss"], max_value=s["max_value"],
                               value=f.broker.opt_value(k), dte=(s["legs"][0]["exp"] - time.time()) / 86400) for k, s in self.mine().items()])
