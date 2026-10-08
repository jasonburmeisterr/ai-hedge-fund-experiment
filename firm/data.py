"""Market data: Coinbase (crypto, real time, free), Alpaca IEX (stocks/ETFs, real time, free with an Alpaca account)
and Yahoo (bar history for everything; futures ~10 min delayed).
Bars still come from Yahoo; the LIVE price for stocks/ETFs comes from Alpaca when keys are set."""
import asyncio
import time

import httpx
import pandas as pd
import yfinance as yf

from .config import INSTRUMENTS, INTRADAY, INST, BAR, BAR_MINUTES, YAHOO_EVERY, DAILY_REFRESH_MIN, ALPACA_KEY, ALPACA_SECRET
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

BAR_SEC = BAR_MINUTES * 60
COLS = ["Open", "High", "Low", "Close", "Volume"]


async def fetch_coinbase(client: httpx.AsyncClient, product: str, gran: int = BAR_SEC) -> pd.DataFrame:
    url = f"https://api.exchange.coinbase.com/products/{product}/candles"
    r = await client.get(url, params={"granularity": gran}, timeout=15)
    r.raise_for_status()
    rows = r.json()  # [time, low, high, open, close, volume], newest first
    df = pd.DataFrame(rows, columns=["t", "Low", "High", "Open", "Close", "Volume"])
    df.index = pd.to_datetime(df["t"], unit="s", utc=True)
    if gran >= 86400:
        df.index = df.index.tz_localize(None).normalize()
    return df[COLS].sort_index().astype(float)


def fetch_yahoo(ids: list[str]) -> dict[str, pd.DataFrame]:
    raw = yf.download(ids, period="1mo", interval=BAR, group_by="ticker",
                      progress=False, auto_adjust=False, threads=True)
    out = {}
    for i in ids:
        try:
            df = raw[i][COLS].dropna()
        except KeyError:
            continue
        df.index = pd.to_datetime(df.index, utc=True)
        out[i] = df.astype(float)
    return out


def fetch_yahoo_daily(ids: list[str], period="2y") -> dict[str, pd.DataFrame]:
    raw = yf.download(ids, period=period, interval="1d", group_by="ticker", progress=False, auto_adjust=True, threads=True)
    out = {}
    for i in ids:
        try:
            df = raw[i][COLS].dropna()
        except KeyError:
            continue
        df.index = pd.to_datetime(df.index)
        out[i] = df.astype(float)
    return out


def daily_bar_complete(inst, day) -> bool:
    """Is the newest daily bar finished? Crypto days end at 00:00 UTC; US ETFs/stocks after 16:15 ET, futures after 17:15 ET."""
    d = pd.Timestamp(day).date()
    if inst["cls"] == "crypto":
        return d < datetime.now(timezone.utc).date()
    et = datetime.now(ZoneInfo("America/New_York"))
    close_hm = (17, 15) if inst["cls"] == "futures" else (16, 15)
    return d < et.date() or (d == et.date() and (et.hour, et.minute) >= close_hm)


def split_bars(df: pd.DataFrame):
    """Return (completed bars, live price, live bar high, live bar low).
    The newest bar is still forming unless its 15 minutes are over."""
    now = time.time()
    last_start = df.index[-1].timestamp()
    if last_start + BAR_SEC > now:
        done, live = df.iloc[:-1], df.iloc[-1]
    else:
        done, live = df, df.iloc[-1]
    return done, float(live["Close"]), float(live["High"]), float(live["Low"])


def market_open(inst: dict, df: pd.DataFrame) -> bool:
    if inst["cls"] == "crypto":
        return True
    # Yahoo is delayed ~15 min; treat the market as open if the last bar is recent
    age = time.time() - df.index[-1].timestamp()
    return age < 45 * 60


class DataDesk:
    """Dot's desk: keeps the latest bars for every instrument."""

    def __init__(self):
        self.bars: dict[str, pd.DataFrame] = {}
        self.live: dict[str, dict] = {}
        self.status: dict[str, bool] = {}
        self.errors: list[str] = []
        self._loops = 0
        self.daily: dict[str, pd.DataFrame] = {}     # completed daily bars, every instrument
        self.daily_px: dict[str, float] = {}         # latest daily close (today's partial bar), ~15 min delayed for ETFs
        self.daily_at = 0.0
        self.rt: dict[str, dict] = {}                # real-time stock/ETF prices from Alpaca IEX: sym -> {px, t, prev}
        self.rt_ok = False

    def feeds(self):
        return dict(crypto="real time · Coinbase", stocks="real time · Alpaca IEX" if self.rt_ok else "~15 min delayed · Yahoo",
                    futures="~10 min delayed · Yahoo", options="live · Deribit")

    async def refresh_rt(self):
        """Latest trade for every stock/ETF from Alpaca's free IEX feed (one request, every loop)."""
        if not (ALPACA_KEY and ALPACA_SECRET):
            return
        syms = [i["sym"] for i in INSTRUMENTS if i["cls"] in ("etf", "stock")]
        try:
            async with httpx.AsyncClient(timeout=10, headers={"APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET}) as cl:
                r = await cl.get("https://data.alpaca.markets/v2/stocks/snapshots", params={"symbols": ",".join(syms), "feed": "iex"})
                r.raise_for_status()
            for s, v in r.json().items():
                lt, prev = v.get("latestTrade") or {}, v.get("prevDailyBar") or {}
                if lt.get("p"):
                    t = datetime.fromisoformat(lt["t"][:26].rstrip("Z") + "+00:00").timestamp() if lt.get("t") else time.time()
                    self.rt[s] = dict(px=float(lt["p"]), t=t, prev=float(prev.get("c") or 0) or None)
            self.rt_ok = True
        except Exception as e:
            self.rt_ok = False
            self.errors.append(f"Alpaca IEX: {type(e).__name__}")

    def is_open(self, sym):
        inst = INST[sym]
        if sym in self.status:
            return self.status[sym]
        if inst["cls"] == "crypto":
            return True
        et = datetime.now(ZoneInfo("America/New_York"))
        return et.weekday() < 5 and (9, 30) <= (et.hour, et.minute) < (16, 0)

    def market_rows(self):
        out = {}
        for inst in INSTRUMENTS:
            s = inst["sym"]
            if s in self.rt:
                v = self.rt[s]
                prev = v["prev"] or (float(self.daily[s]["Close"].iloc[-1]) if s in self.daily and len(self.daily[s]) else v["px"])
                out[s] = dict(px=v["px"], chg=v["px"] / prev - 1, open=self.is_open(s), cls=inst["cls"], name=inst["name"], rt=True)
            elif s in self.live:
                v = self.live[s]
                out[s] = dict(px=v["px"], chg=v["chg_24h"], open=self.status.get(s, False), cls=inst["cls"], name=inst["name"])
            elif s in self.daily_px and s in self.daily and len(self.daily[s]):
                prev = float(self.daily[s]["Close"].iloc[-1])
                px = self.daily_px[s]
                out[s] = dict(px=px, chg=px / prev - 1 if prev else 0.0, open=self.is_open(s), cls=inst["cls"], name=inst["name"])
        return out

    def price(self, sym):
        """Best available live price: real-time Alpaca for stocks/ETFs, else the 15-minute desk, else the daily feed."""
        if sym in self.rt:
            return self.rt[sym]["px"]
        if sym in self.live:
            return self.live[sym]["px"]
        return self.daily_px.get(sym)

    async def refresh_daily(self, force=False):
        if not force and time.time() - self.daily_at < DAILY_REFRESH_MIN * 60:
            return False
        try:
            frames = await asyncio.to_thread(fetch_yahoo_daily, [i["id"] for i in INSTRUMENTS if i["cls"] != "crypto"])
        except Exception as e:
            self.errors.append(f"Yahoo daily: {e}")
            return False
        async with httpx.AsyncClient(headers={"User-Agent": "jb-capital-floor/1.0"}) as client:   # crypto: the exchange's own daily candles
            for inst in INSTRUMENTS:
                if inst["cls"] == "crypto":
                    try:
                        frames[inst["id"]] = await fetch_coinbase(client, inst["id"], gran=86400)
                    except Exception as e:
                        self.errors.append(f"Coinbase daily {inst['sym']}: {type(e).__name__}")
        for inst in INSTRUMENTS:
            df = frames.get(inst["id"])
            if df is None or len(df) < 30:
                continue
            self.daily_px[inst["sym"]] = float(df["Close"].iloc[-1])
            self.daily[inst["sym"]] = df.iloc[:-1] if not daily_bar_complete(inst, df.index[-1]) else df
        self.daily_at = time.time()
        return True

    async def refresh(self):
        self.errors = []
        async with httpx.AsyncClient(headers={"User-Agent": "jb-capital-floor/1.0"}) as client:
            crypto = [i for i in INTRADAY if i["src"] == "coinbase"]
            results = await asyncio.gather(*(fetch_coinbase(client, i["id"]) for i in crypto),
                                           return_exceptions=True)
            for k, (inst, res) in enumerate(zip(crypto, results)):   # one retry for flaky requests
                if isinstance(res, Exception):
                    await asyncio.sleep(1)
                    try:
                        results[k] = await fetch_coinbase(client, inst["id"])
                    except Exception as e:
                        results[k] = e
            for inst, res in zip(crypto, results):
                if isinstance(res, Exception):
                    self.errors.append(f"Coinbase {inst['sym']}: {type(res).__name__} {res}".strip())
                else:
                    self._store(inst, res)

        if self._loops % YAHOO_EVERY == 0 or not any(i["sym"] in self.bars for i in INTRADAY if i["src"] == "yahoo"):
            yahoo = [i for i in INTRADAY if i["src"] == "yahoo"]
            try:
                frames = await asyncio.to_thread(fetch_yahoo, [i["id"] for i in yahoo])
                for inst in yahoo:
                    if inst["id"] in frames and len(frames[inst["id"]]):
                        self._store(inst, frames[inst["id"]])
            except Exception as e:  # Yahoo rate limits happen; try again next loop
                self.errors.append(f"Yahoo: {e}")
        self._loops += 1

    def _store(self, inst, df):
        done, px, hi, lo = split_bars(df)
        self.bars[inst["sym"]] = done
        prev_close = float(done["Close"].iloc[-1]) if len(done) else px
        day_ago = done["Close"].iloc[-96] if len(done) > 96 else done["Close"].iloc[0]
        self.live[inst["sym"]] = dict(px=px, hi=hi, lo=lo, chg_bar=px / prev_close - 1,
                                      chg_24h=px / float(day_ago) - 1)
        self.status[inst["sym"]] = market_open(inst, df)


# ── indicators ──────────────────────────────────────────────
def indicators(df: pd.DataFrame) -> dict:
    h, l, c = df["High"], df["Low"], df["Close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 14, adjust=False).mean()
    sma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    return dict(
        t=df.index[-1],
        close=float(c.iloc[-1]),
        atr=float(atr.iloc[-1]),
        atr_pct_rank=float((atr.iloc[-100:] <= atr.iloc[-1]).mean()),
        ema50=float(c.ewm(span=50, adjust=False).mean().iloc[-1]),
        hi20=float(h.iloc[-21:-1].max()),
        lo20=float(l.iloc[-21:-1].min()),
        z=float((c.iloc[-1] - sma20.iloc[-1]) / std20.iloc[-1]) if std20.iloc[-1] > 0 else 0.0,
        ret_1h=float(c.iloc[-1] / c.iloc[-5] - 1),
        ret_4h=float(c.iloc[-1] / c.iloc[-17] - 1) if len(c) > 17 else 0.0,
    )
