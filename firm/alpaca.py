"""Eddie's line to a REAL broker: Alpaca (paper account by default).

The floor's own ledger stays the source of the pods' P&L. Alpaca mirrors the fund's NET position in every market it
supports (US ETFs/stocks + BTC/ETH/SOL), scaled to the Alpaca account's size. Every few minutes Eddie RECONCILES:
target = what the fund holds; actual = what Alpaca says it holds; the difference is sent as one order. That makes it
safe across restarts (no duplicate orders) and self-healing after a rejected or partial fill.

Safety:
  - keys live in ai-trading-floor/.env (never committed); without keys the mirror is simply off
  - PAPER is the default; live trading needs ALPACA_LIVE=1 on purpose
  - per-order notional cap, ETF orders only during regular hours, a daily-loss kill switch, and an off button
Futures (MNQ/MGC) are not on Alpaca and stay simulated."""
import time

import httpx

from . import config as C

CRYPTO_PAIR = {"BTC": "BTC/USD", "ETH": "ETH/USD", "SOL": "SOL/USD"}


def supported(sym):
    return C.INST[sym]["cls"] in ("etf", "stock") or sym in CRYPTO_PAIR


def alp_sym(sym):
    return CRYPTO_PAIR.get(sym, sym)


class AlpacaMirror:
    def __init__(self, st: dict | None = None):
        st = st or {}
        self.key, self.secret = C.ALPACA_KEY, C.ALPACA_SECRET
        self.live = C.ALPACA_LIVE
        self.base = "https://api.alpaca.markets" if self.live else "https://paper-api.alpaca.markets"
        self.enabled = bool(self.key and self.secret) and st.get("enabled", True)
        self.killed = st.get("killed")             # reason string if the kill switch fired
        self.day_open_eq: dict = st.get("day_open_eq", {})
        self.account: dict = {}
        self.positions: dict = {}                  # alpaca symbol -> qty (signed)
        self.drift: dict = {}
        self.orders: list = st.get("orders", [])   # recent orders we sent
        self.error = None
        self.last_sync = 0.0
        self.blocked_said: dict = {}               # sym -> day we last reported a blocked order (once a day, not every sync)

    def to_state(self):
        # don't persist 'off' just because keys were missing
        return dict(enabled=self.enabled if self.configured else True, killed=self.killed, day_open_eq=self.day_open_eq,
                    orders=self.orders[-50:])

    @property
    def configured(self):
        return bool(self.key and self.secret)

    def _client(self):
        return httpx.AsyncClient(base_url=self.base, timeout=15,
                                 headers={"APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.secret})

    async def refresh(self, cl):
        r = await cl.get("/v2/account")
        r.raise_for_status()
        a = r.json()
        self.account = dict(equity=float(a["equity"]), cash=float(a["cash"]), buying_power=float(a["buying_power"]),
                            status=a.get("status"), blocked=a.get("trading_blocked") or a.get("account_blocked"))
        r = await cl.get("/v2/positions")
        r.raise_for_status()
        self.positions = {}
        for p in r.json():
            sym = p["symbol"]
            for ours, pair in CRYPTO_PAIR.items():          # positions come back as BTCUSD
                if sym == pair.replace("/", ""):
                    sym = pair
            self.positions[sym] = float(p["qty"]) * (1 if p.get("side", "long") == "long" else -1)

    def check_kill(self):
        day = time.strftime("%Y-%m-%d")
        eq = self.account.get("equity")
        if not eq:
            return None
        start = self.day_open_eq.setdefault(day, eq)
        if eq < start * (1 - C.ALPACA_DAILY_LOSS_KILL) and not self.killed:
            self.killed = f"daily loss {eq / start - 1:.1%} hit the {C.ALPACA_DAILY_LOSS_KILL:.0%} kill switch"
            return self.killed
        return None

    async def sync(self, fund_positions: dict, fund_equity: float, prices: dict, is_open) -> list[str]:
        """fund_positions: {pos_key: position dict} from the floor's ledger. Returns messages for the floor chat."""
        msgs = []
        if not self.configured or not self.enabled:
            return msgs
        self.last_sync = time.time()
        try:
            async with self._client() as cl:
                await self.refresh(cl)
                if (k := self.check_kill()):
                    msgs.append(f"KILL SWITCH: {k}. Flattening the broker account and stopping all orders.")
                    await cl.delete("/v2/positions", params={"cancel_orders": "true"})
                    return msgs
                if self.killed or self.account.get("blocked"):
                    return msgs
                scale = self.account["equity"] / fund_equity if fund_equity > 0 else 0.0
                target: dict = {}
                for p in fund_positions.values():
                    if supported(p["sym"]):
                        target[p["sym"]] = target.get(p["sym"], 0.0) + p["side"] * p["qty"] * scale
                syms = set(target) | {s for s in C.INST if supported(s) and self.positions.get(alp_sym(s))}
                self.drift = {}
                for sym in sorted(syms):
                    inst, a = C.INST[sym], alp_sym(sym)
                    have = self.positions.get(a, 0.0)
                    want = target.get(sym, 0.0)
                    if inst["step"] >= 1:
                        want = float(int(round(want, 6)))        # whole shares, rounded toward zero
                    else:
                        want = round(int(round(want / inst["step"], 6)) * inst["step"], 8)
                    diff = want - have
                    px = prices.get(sym)
                    if not px or abs(diff) < inst["step"] * 0.999:
                        continue
                    self.drift[sym] = diff
                    if sym not in CRYPTO_PAIR and not is_open(sym):
                        continue                                 # ETFs: only during regular hours
                    notional = abs(diff) * px
                    if notional > C.ALPACA_MAX_ORDER * self.account["equity"]:
                        if self.blocked_said.get(sym) != time.strftime("%Y-%m-%d"):
                            self.blocked_said[sym] = time.strftime("%Y-%m-%d")
                            msgs.append(f"Blocked a {sym} order: ${notional:,.0f} is over the {C.ALPACA_MAX_ORDER:.0%} per-order cap. "
                                        "The broker account stays out of sync on it until the fund's position shrinks.")
                        continue
                    if notional < 1.0:
                        continue
                    body = dict(symbol=a, qty=format(abs(round(diff, 8)), "f").rstrip("0").rstrip("."), side="buy" if diff > 0 else "sell", type="market",
                                time_in_force="gtc" if sym in CRYPTO_PAIR else "day")
                    r = await cl.post("/v2/orders", json=body)
                    if r.status_code >= 300:
                        msgs.append(f"Alpaca rejected {body['side']} {body['qty']} {a}: {r.text[:120]}")
                        continue
                    o = r.json()
                    self.orders.append(dict(t=time.time(), sym=sym, side=body["side"], qty=abs(diff), id=o.get("id"), px=px))
                    msgs.append(f"Sent to Alpaca{' (LIVE)' if self.live else ' paper'}: {body['side']} {abs(diff):g} {a} (~${notional:,.0f}).")
                self.error = None
        except httpx.HTTPStatusError as e:
            self.error = f"HTTP {e.response.status_code}: {e.response.text[:100]}"
            if e.response.status_code in (401, 403):
                msgs.append("Alpaca refused the API keys. Check ALPACA_KEY / ALPACA_SECRET in .env.")
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"[:140]
        return msgs

    def snapshot(self):
        return dict(configured=self.configured, enabled=self.enabled, live=self.live, killed=self.killed, error=self.error,
                    account=self.account, positions=self.positions, drift=self.drift, orders=self.orders[-8:],
                    last_sync=self.last_sync)
