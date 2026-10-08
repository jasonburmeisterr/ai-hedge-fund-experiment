"""Vic's GEX desk: dealer gamma exposure from real option chains.

  BTC, ETH : live Deribit chains (the same feed Opal trades), recomputed every few minutes
  SPY, QQQ : listed chains from CBOE's free delayed feed (open interest is published once a day anyway)

Convention (the common "naive GEX"): customers mostly BUY puts and SELL calls, so dealers are LONG call gamma and
SHORT put gamma. GEX($ per 1% move) = sum(call gamma * OI) - sum(put gamma * OI), times spot^2 * 1% * multiplier.
  - positive GEX: dealers hedge AGAINST moves (buy dips, sell rips) -> calmer, mean-reverting tape
  - negative GEX: dealers hedge WITH moves -> moves get amplified
  - gamma flip: the spot price where total GEX changes sign; call/put walls: strikes with the most gamma

It's an estimate: real dealer positioning isn't public. So GEX is NOT used for trading. Vic forward-tests the one
claim it makes (negative-gamma days move more than positive-gamma days) on non-overlapping 24h windows. Only a
recorded, passed test could ever earn it a place in sizing, and that switch is Jason's."""
import asyncio
import math
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from .options import bs

SYMS = ["BTC", "ETH", "SPY", "QQQ"]
MIN_OBS = 15              # per regime before the forward test can give a verdict
RATIO_PASS = 1.3          # negative-gamma days must move >= 1.3x more than positive-gamma days


def gex_at(spot, legs):
    """Total dealer GEX in $ per 1% move at a hypothetical spot. legs: (strike, T_years, iv, oi, kind, mult)."""
    tot = 0.0
    for k, T, iv, oi, kind, mult in legs:
        g = bs(spot, k, T, iv, kind)["gamma"]
        tot += (1 if kind == "C" else -1) * g * oi * mult * spot * spot * 0.01
    return tot


def analyze(sym, spot, legs):
    if not legs or not spot:
        return None
    total = gex_at(spot, legs)
    grid = [spot * (0.85 + 0.005 * i) for i in range(61)]
    curve = [gex_at(s, legs) for s in grid]
    flip = None
    for (a, ga), (b, gb) in zip(zip(grid, curve), zip(grid[1:], curve[1:])):
        if ga == 0 or (ga < 0) != (gb < 0):
            x = a + (b - a) * (ga / (ga - gb)) if ga != gb else a
            if flip is None or abs(x - spot) < abs(flip - spot):
                flip = x
    by = {}
    for k, T, iv, oi, kind, mult in legs:
        g = bs(spot, k, T, iv, kind)["gamma"] * oi * mult * spot * spot * 0.01
        c, p = by.get(k, (0.0, 0.0))
        by[k] = (c + g, p) if kind == "C" else (c, p + g)
    near = sorted(k for k in by if 0.85 * spot <= k <= 1.15 * spot)
    call_wall = max(near, key=lambda k: by[k][0], default=None)
    put_wall = max(near, key=lambda k: by[k][1], default=None)
    step = max(1, len(near) // 40)                       # at most ~40 bars for the chart
    profile = [[k, round(by[k][0]), round(-by[k][1])] for k in near[::step]]
    return dict(sym=sym, spot=spot, gex=total, regime="positive" if total >= 0 else "negative", flip=flip,
                call_wall=call_wall, put_wall=put_wall, profile=profile, legs=len(legs), t=time.time())


def crypto_legs(chain, cur):
    now = time.time()
    out = []
    for o in chain.opts.values():
        T = (o["exp"] - now) / (365 * 86400)
        if o["cur"] == cur and 0 < T <= 60 / 365 and o["oi"] > 0 and o["iv"] > 0.01:
            out.append((o["strike"], T, o["iv"], o["oi"], o["kind"], 1.0))        # Deribit: 1 contract = 1 coin
    return out


def cboe_legs(sym):
    """Listed ETF chain from CBOE's free delayed-quotes feed (OI + IV for every option, available 24/7)."""
    import httpx
    r = httpx.get(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{sym}.json", timeout=30, follow_redirects=True,
                  headers={"User-Agent": "Mozilla/5.0 (jb-capital-gex)"})
    r.raise_for_status()
    d = r.json()["data"]
    now = datetime.now(ZoneInfo("America/New_York"))
    out = []
    for o in d["options"]:
        name = o["option"]                                   # e.g. SPY261231P00610000
        oi, iv = float(o.get("open_interest") or 0), float(o.get("iv") or 0)
        if oi <= 0 or not 0.03 < iv < 3:
            continue
        exp = datetime.strptime(name[-15:-9], "%y%m%d").replace(hour=16, tzinfo=ZoneInfo("America/New_York"))
        T = (exp - now).total_seconds() / (365 * 86400)
        if 0 < T <= 45 / 365:
            out.append((int(name[-8:]) / 1000, T, iv, oi, name[-9], 100.0))      # listed options: 100 shares
    return out, float(d.get("current_price") or 0)


class GexDesk:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.snap: dict = st.get("snap", {})
        self.obs: list = st.get("obs", [])            # forward test: {sym, t, spot, regime, gex, ret}
        self.last = {}
        self.error = None

    def to_state(self):
        return dict(snap={k: {kk: vv for kk, vv in v.items() if kk != "profile"} for k, v in self.snap.items()}, obs=self.obs[-600:])

    async def step(self):
        f = self.floor
        now = time.time()
        for cur in ("BTC", "ETH"):
            if now - self.last.get(cur, 0) > 300 and f.chain.opts:
                self.last[cur] = now
                await self._update(cur, f.chain.index.get(cur), crypto_legs(f.chain, cur))
        for sym in ("SPY", "QQQ"):
            if now - self.last.get(sym, 0) > 1800:
                self.last[sym] = now
                try:
                    legs, cboe_px = await asyncio.to_thread(cboe_legs, sym)
                    await self._update(sym, f.desk.price(sym) or cboe_px, legs)
                    self.error = None
                except Exception as e:  # feed hiccups: try again next window
                    self.error = f"{sym} chain: {type(e).__name__}"
        self._grade()

    async def _update(self, sym, spot, legs):
        res = await asyncio.to_thread(analyze, sym, spot, legs)
        if not res:
            return
        prev = self.snap.get(sym)
        self.snap[sym] = res
        if prev and prev["regime"] != res["regime"]:
            hint = "moves may get amplified" if res["regime"] == "negative" else "dealers now dampen moves"
            await self.floor.say("vic", "vol", f"{sym} dealer gamma flipped {res['regime'].upper()}: {hint}. "
                                 f"Flip level {res['flip']:,.0f}." if res["flip"] else f"{sym} gamma flipped {res['regime']}.")
        last = next((o for o in reversed(self.obs) if o["sym"] == sym), None)
        if not last or time.time() - last["t"] >= 24 * 3600:                    # one non-overlapping observation per day
            self.obs.append(dict(sym=sym, t=time.time(), spot=spot, regime=res["regime"], gex=res["gex"], ret=None))

    def _grade(self):
        for o in self.obs:
            if o["ret"] is None and time.time() - o["t"] >= 24 * 3600:
                px = self.floor.desk.price(o["sym"]) if o["sym"] != "BTC" and o["sym"] != "ETH" else self.floor.chain.index.get(o["sym"])
                if px and o["spot"]:
                    o["ret"] = px / o["spot"] - 1

    def test(self):
        done = [o for o in self.obs if o["ret"] is not None]
        side = {r: [abs(o["ret"]) for o in done if o["regime"] == r] for r in ("positive", "negative")}
        n_pos, n_neg = len(side["positive"]), len(side["negative"])
        m_pos = sum(side["positive"]) / n_pos if n_pos else None
        m_neg = sum(side["negative"]) / n_neg if n_neg else None
        ratio = m_neg / m_pos if m_pos and m_neg else None
        if n_pos < MIN_OBS or n_neg < MIN_OBS:
            verdict = f"collecting ({n_pos}/{MIN_OBS} positive-gamma days, {n_neg}/{MIN_OBS} negative)"
        else:
            verdict = "SUPPORTED" if ratio and ratio >= RATIO_PASS else "NOT SUPPORTED"
        return dict(n_pos=n_pos, n_neg=n_neg, move_pos=m_pos, move_neg=m_neg, ratio=ratio, verdict=verdict,
                    pending=sum(1 for o in self.obs if o["ret"] is None))

    def snapshot(self):
        return dict(syms={k: v for k, v in self.snap.items() if time.time() - v["t"] < 3 * 86400}, test=self.test(), error=self.error)

    def huddle_line(self):
        parts = [f"{s} {'+' if v['gex'] >= 0 else '-'}${abs(v['gex']) / 1e6:,.0f}M/1%" + (f" flip {v['flip']:,.0f}" if v.get("flip") else "")
                 for s, v in self.snap.items() if time.time() - v["t"] < 86400]
        return ("GEX: " + ", ".join(parts) + f". Forward test: {self.test()['verdict']}.") if parts else ""
