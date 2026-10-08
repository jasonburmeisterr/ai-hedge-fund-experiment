"""Sam the scorekeeper: grades every call an agent makes, one hour later.
An agent's TRUST (how much the Boss listens) comes from its measured edge, not from opinions."""
import pandas as pd

from .config import BAR_MINUTES, SCORE_HORIZON_BARS, SCORE_HORIZON_DAYS, MIN_CALLS_FOR_TRUST


class Scorekeeper:
    def __init__(self, state: dict | None = None):
        s = state or {}
        self.pending: list[dict] = s.get("pending", [])
        self.results: dict[str, list[float]] = s.get("results", {})

    def to_state(self):
        return dict(pending=self.pending[-500:], results={k: v[-300:] for k, v in self.results.items()})

    def record(self, agent, sym, direction, price, bar_time: pd.Timestamp, tf="15m"):
        if tf == "1d":
            due = bar_time + pd.tseries.offsets.BDay(SCORE_HORIZON_DAYS)
        elif tf == "1h":
            due = bar_time + pd.Timedelta(hours=6)          # 1h PMs: graded ~6 bars later (next session for stocks)
        else:
            due = bar_time + pd.Timedelta(minutes=BAR_MINUTES * SCORE_HORIZON_BARS)
        self.pending.append(dict(agent=agent, sym=sym, dir=direction, price=price, due=due.isoformat(), tf=tf))

    def record_result(self, agent, ret):
        """For pods graded on trade results instead of directional calls (the options desk)."""
        self.results.setdefault(agent, []).append(float(ret) / 100)  # scale: a full max-loss trade = -100 bps

    def evaluate(self, bars: dict, daily: dict | None = None, hourly: dict | None = None) -> list[dict]:
        """Grade every call whose time is up (1 hour for 15-minute PMs, 5 trading days for daily PMs)."""
        graded, still = [], []
        for c in self.pending:
            tf = c.get("tf")
            df = (daily or {}).get(c["sym"]) if tf == "1d" else (hourly or {}).get(c["sym"]) if tf == "1h" else bars.get(c["sym"])
            due = pd.Timestamp(c["due"])
            if df is None or not len(df) or df.index[-1] < due:
                still.append(c)
                continue
            px = float(df.loc[df.index >= due, "Close"].iloc[0])
            ret = (px / c["price"] - 1) * c["dir"]
            self.results.setdefault(c["agent"], []).append(ret)
            graded.append({**c, "ret": ret})
        self.pending = still
        return graded

    def stats(self, agent) -> dict:
        r = self.results.get(agent, [])[-200:]
        n = len(r)
        if n == 0:
            return dict(n=0, hit=None, edge_bps=None, trust=1.0)
        hit = sum(x > 0 for x in r) / n
        edge = sum(r) / n * 1e4
        trust = 1.0
        if n >= MIN_CALLS_FOR_TRUST:
            # +20 bps average edge per call -> trust 2.0; -15 bps -> 0.25
            trust = max(0.25, min(2.0, 1.0 + edge / 20))
        return dict(n=n, hit=hit, edge_bps=edge, trust=trust)
