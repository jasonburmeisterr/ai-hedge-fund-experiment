"""Dot's correlation & overlap report (requested by Dot on the Wire: "five tsmom passes may be one bet").

For every active daily PM it backtests the current strategy over the full daily history and measures:
  - return correlation: daily mark-to-market P&L of each PM's book (equal size per position), summed weekly, pairwise
  - trade overlap: of the days both PMs are in the market, how often they hold the SAME market in the SAME direction
  - effective number of independent bets: N^2 / sum of the correlation matrix (equal weights). 5 PMs that all make
    the same bet count as ~1; 5 unrelated PMs count as ~5
  - clusters: groups of PMs linked by correlation >= CLUSTER_CORR or position overlap >= CLUSTER_OVERLAP
  - live overlap right now: markets held by more than one pod
Recomputed every few hours or as soon as a strategy changes. It feeds the risk desk, the research lab, the team's
reflections and the CIO's allocation (fund.overlap_factors: look-alike pods share one budget)."""
import asyncio
import hashlib
import json
import time

import pandas as pd

from . import config as C
from .backtest import evaluate_daily
from .strategies import FAMILIES

CLUSTER_CORR = 0.6
CLUSTER_OVERLAP = 0.75
EVERY_H = 6


def market_returns(daily: dict) -> pd.Series:
    """(date, sym) -> daily close-to-close return, for every market."""
    return pd.concat({s: df["Close"].pct_change() for s, df in daily.items()}, axis=1).stack()


def book(daily: dict, R: pd.Series, tr, tf: str = "1d"):
    """Day-by-day holdings of a backtest's trades (+1 long / -1 short per market, held through the close of each day
    after entry) and the book's daily mark-to-market return with equal size per position. (None, None) if empty."""
    if tr is None or not len(tr):
        return None, None
    rows = []
    for t in tr.itertuples():
        if t.sym not in daily:
            continue
        e0, e1 = (pd.Timestamp(x).tz_convert("America/New_York").tz_localize(None).normalize() if pd.Timestamp(x).tzinfo
                  else pd.Timestamp(x) for x in (t.entry, t.exit))
        lo = e0 if tf == "1h" else e0 + pd.Timedelta(seconds=1)
        for d in daily[t.sym].index[(daily[t.sym].index >= lo) & (daily[t.sym].index <= e1)]:
            rows.append((d, t.sym, t.side))
    if not rows:
        return None, None
    h = pd.DataFrame(rows, columns=["d", "sym", "side"]).drop_duplicates(["d", "sym"]).set_index(["d", "sym"]).side
    return h, (h * R.reindex(h.index).fillna(0.0)).groupby(level=0).mean()


class OverlapDesk:
    def __init__(self, floor, st: dict):
        self.floor = floor
        self.report: dict | None = st.get("report")
        self.key = st.get("key", "")
        self.last = st.get("last", 0.0)
        self.running = False
        self.flagged: list = st.get("flagged", [])

    def to_state(self):
        return dict(report=self.report, key=self.key, last=self.last, flagged=self.flagged[-20:])

    def pods(self):
        f = self.floor
        return [a for a in f.roster if a["family"] in FAMILIES and a.get("tf") in ("1d", "1h") and a["id"] not in f.stopped
                and (a["tf"] == "1d" or f.hdesk.bars)]

    def roster_key(self):
        sig = [(a["id"], a["family"], a["params"], a.get("markets")) for a in self.pods()]
        return hashlib.md5(json.dumps(sig, sort_keys=True, default=str).encode()).hexdigest()

    async def step(self):
        f = self.floor
        if self.running or not f.lab.recertified or not f.lab.daily:
            return
        k = self.roster_key()
        if k == self.key and time.time() - self.last < EVERY_H * 3600:
            return
        self.running = True
        try:
            first = self.report is None
            self.report = await asyncio.to_thread(self.compute)
            self.key, self.last = k, time.time()
            await self.announce(first)
            if f.reallocate():       # the CIO sizes look-alike pods as one shared bet
                top = sorted(((f.names[i], w, f.dup.get(i)) for i, w in f.alloc.items() if w > 0), key=lambda x: -x[1])
                await f.say("boss", "system", "New allocations after Dot's overlap report (look-alike PMs share one budget): "
                            + ", ".join(f"{n} {w:.0%}" + (f" (bet held ~{d:.1f}x)" if d and d >= 1.5 else "") for n, w, d in top), pause=2)
        except Exception as e:      # never let the report crash the floor
            await f.say("dot", "chatter", f"Correlation report failed: {e!r}"[:140])
        finally:
            self.running = False

    def compute(self):
        f = self.floor
        daily = f.lab.daily
        pods = self.pods()
        weekly, holds, info = {}, {}, {}
        R = market_returns(daily)
        for a in pods:
            res = evaluate_daily(f.lab.history_for(a.get("tf", "1d")), a["family"], a["params"], a.get("markets") or C.DAILY_UNIVERSE)
            h, pnl = book(daily, R, res.get("trades"), a.get("tf", "1d"))
            if h is None:
                continue
            holds[a["id"]] = h
            weekly[a["id"]] = pnl.resample("W").sum()
            info[a["id"]] = dict(name=a["name"], desc=a.get("desc", ""), days=int(h.index.get_level_values(0).nunique()))
        ids = list(weekly)
        if len(ids) < 2:
            return dict(t=time.time(), ids=ids, names={i: info[i]["name"] for i in ids}, corr=[], overlap=[], n=len(ids),
                        n_eff=float(len(ids)), clusters=[], pairs=[], live=self.live(), note="need at least 2 daily PMs")
        W = pd.concat(weekly, axis=1).fillna(0.0)
        W = W[W.index >= W.index[-1] - pd.DateOffset(years=10)]
        corr = W.corr().reindex(index=ids, columns=ids).fillna(0.0)
        ov = pd.DataFrame(0.0, index=ids, columns=ids)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                ha, hb = holds[a], holds[b]
                both = ha.index.intersection(hb.index)
                same = int((ha.loc[both] == hb.loc[both]).sum()) if len(both) else 0
                v = same / max(1, min(len(ha), len(hb)))          # share of the smaller book's position-days duplicated
                ov.loc[a, b] = ov.loc[b, a] = round(v, 3)
            ov.loc[a, a] = 1.0
        n = len(ids)
        cm = corr.values.clip(-1, 1)
        n_eff = float(n * n / max(cm.sum(), 1e-9))
        n_eff = max(1.0, min(float(n), n_eff))
        # clusters: connected groups (similar returns OR mostly the same positions)
        seen, clusters = set(), []
        for a in ids:
            if a in seen:
                continue
            grp, stack = [], [a]
            while stack:
                x = stack.pop()
                if x in seen:
                    continue
                seen.add(x)
                grp.append(x)
                stack += [y for y in ids if y not in seen and (corr.loc[x, y] >= CLUSTER_CORR or ov.loc[x, y] >= CLUSTER_OVERLAP)]
            if len(grp) > 1:
                clusters.append(grp)
        pairs = sorted(([a, b, round(float(corr.loc[a, b]), 2), round(float(ov.loc[a, b]), 2)]
                        for i, a in enumerate(ids) for b in ids[i + 1:]), key=lambda p: -p[2])
        return dict(t=time.time(), ids=ids, names={i: info[i]["name"] for i in ids}, descs={i: info[i]["desc"] for i in ids},
                    corr=[[round(float(x), 2) for x in row] for row in corr.values],
                    overlap=[[round(float(x), 2) for x in row] for row in ov.values],
                    n=n, n_eff=round(n_eff, 2), clusters=clusters, pairs=pairs[:10], live=self.live(),
                    weeks=len(W), since=str(W.index[0].date()))

    def live(self):
        """Markets held by more than one pod right now."""
        by = {}
        for p in self.floor.broker.positions.values():
            by.setdefault(p["sym"], []).append((p["pod"], p["side"]))
        return [dict(sym=s, pods=[dict(id=i, name=self.floor.names.get(i, i), side=sd) for i, sd in v])
                for s, v in by.items() if len(v) > 1]

    def brief_line(self):
        r = self.report
        if not r or r["n"] < 2:
            return ""
        nm = r["names"]
        cl = "; ".join(" + ".join(nm[i] for i in g) for g in r["clusters"]) or "none"
        top = r["pairs"][0] if r["pairs"] else None
        return (f"Team correlation (Dot's report): {r['n']} daily PMs = {r['n_eff']:.1f} independent bets. Clusters (corr >= {CLUSTER_CORR} or >= {CLUSTER_OVERLAP:.0%} same positions): {cl}."
                + (f" Most similar pair: {nm[top[0]]} & {nm[top[1]]} (corr {top[2]:.2f}, {top[3]:.0%} same positions)." if top else "")
                + " New strategies that are UNcorrelated with the team add the most value.")

    async def announce(self, first):
        f = self.floor
        r = self.report
        if not r or r["n"] < 2:
            return
        line = self.brief_line()
        await f.say("dot", "data", line[:300], pause=3)
        if r["clusters"]:
            big = max(r["clusters"], key=len)
            key = "|".join(sorted(big))
            if key not in self.flagged:
                self.flagged.append(key)
                await f.say("rex", "risk", f"Noted: {' + '.join(r['names'][i] for i in big)} behave like one bet. "
                            f"Their combined size is effectively concentrated risk.", pause=3, ok=False)
        if first:     # Dot's tool request is now built
            for req in f.minds.requests:
                if req["by"] == "dot" and req["status"] == "asked" and "correlation" in req["what"].lower():
                    req["status"] = "built"
            await f.minds.remember("dot", "built", "My correlation & overlap report got built. Now everyone can see hidden duplicate bets.", xp=40, valence=1)
            await f.board.post("fund", "dot", "jason", "tool_built",
                               f"Thanks for building my correlation report. First read: {line[:400]}")

    def snapshot(self):
        return dict(report=self.report, running=self.running, cluster_corr=CLUSTER_CORR, cluster_overlap=CLUSTER_OVERLAP)
