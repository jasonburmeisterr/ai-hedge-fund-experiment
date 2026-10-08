"""Fund operations: what the back office does at a real fund.

  - NAV strike (4:15 pm New York, weekdays): Nova strikes the official NAV. Fees accrue the way a real hedge fund charges
    them: a 2% a year management fee (daily, on gross assets) and a 20% performance fee on gains above the high-water
    mark (accrued daily, crystallized each December 31). Gross NAV = what the strategies made; net NAV = what an investor
    keeps. Paper trading: the fees are shadow accounting, they don't touch the broker balance.
  - End-of-day report (4:20 pm): Sam writes the day up: P&L, attribution by pod, trades, best and worst, VaR, the CIO's
    stance, compliance, research. Archived (last 60) and shown in the Reports window.
  - Investor statement: the numbers an LP would see (gross vs net, fees, high-water mark, monthly net returns)."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from . import config as C

NY = ZoneInfo("America/New_York")
MGMT, PERF = 0.02, 0.20


class FundOps:
    def __init__(self, floor, st: dict):
        self.f = floor
        st = st or {}
        self.strikes: list = st.get("strikes", [])[-400:]     # [{day, gross, net, mgmt, perf, hwm}]
        self.mgmt_total = float(st.get("mgmt_total", 0.0))     # $ management fee accrued since inception
        self.perf_accr = float(st.get("perf_accr", 0.0))       # $ performance fee accrued this year (not yet crystallized)
        self.perf_paid = float(st.get("perf_paid", 0.0))
        self.hwm = float(st.get("hwm", C.STARTING_CASH))       # net equity high-water mark (after fees)
        self.reports: list = st.get("reports", [])[-60:]
        self.strike_day, self.report_day = st.get("strike_day"), st.get("report_day")
        self.year = st.get("year", datetime.now(NY).year)

    def to_state(self):
        return dict(strikes=self.strikes[-400:], mgmt_total=self.mgmt_total, perf_accr=self.perf_accr, perf_paid=self.perf_paid, hwm=self.hwm,
                    reports=self.reports[-60:], strike_day=self.strike_day, report_day=self.report_day, year=self.year)

    def net_equity(self, gross):
        return gross - self.mgmt_total - self.perf_paid - self.perf_accr

    async def strike(self, day):
        f = self.f
        gross = f.broker.equity(f.prices())
        last = self.strikes[-1]["day"] if self.strikes else None
        days = 1
        if last:
            try:
                days = max(1, (datetime.fromisoformat(day) - datetime.fromisoformat(last)).days)
            except ValueError:
                days = 1
        self.mgmt_total += gross * MGMT * days / 365
        y = datetime.now(NY).year
        if y != self.year:                       # a new year: last year's performance fee crystallizes
            self.perf_paid += self.perf_accr
            self.perf_accr, self.year = 0.0, y
        pre = gross - self.mgmt_total - self.perf_paid
        self.perf_accr = max(0.0, PERF * (pre - self.hwm))
        net = pre - self.perf_accr
        if self.perf_accr == 0.0 and net > self.hwm:
            self.hwm = net
        rec = dict(day=day, gross=round(100 * gross / C.STARTING_CASH, 4), net=round(100 * net / C.STARTING_CASH, 4),
                   mgmt=round(self.mgmt_total, 2), perf=round(self.perf_accr + self.perf_paid, 2), hwm=round(100 * self.hwm / C.STARTING_CASH, 4))
        self.strikes.append(rec)
        await f.say("nova", "ops", f"Official NAV struck for {day}: gross {rec['gross']:.2f}, net of fees {rec['net']:.2f} "
                    f"(management fee accrued ${self.mgmt_total:,.0f}, performance fee ${self.perf_accr:,.0f}). Books reconciled.", pause=1)

    async def eod_report(self, day):
        f = self.f
        s = f.snapshot()
        px = f.prices()
        trades = [t for t in f.broker.trades if datetime.fromtimestamp(t.get("closed", 0), NY).strftime("%Y-%m-%d") == day]
        pods = sorted(((p["name"], p["pnl"]) for p in s["roster"]), key=lambda x: -x[1])
        best = max(trades, key=lambda t: t["pnl"], default=None)
        worst = min(trades, key=lambda t: t["pnl"], default=None)
        rr = f.riskrep.last or {}
        cp = f.compliance.snapshot()["today"]
        ml = f.mlab
        models_today = [m for m in ml.models if datetime.fromtimestamp(m["t"], NY).strftime("%Y-%m-%d") == day]
        ideas_today = [e for e in f.lab.log if datetime.fromtimestamp(e.get("t", 0), NY).strftime("%Y-%m-%d") == day]
        F = f.cio.fund()
        rep = dict(day=day, t=time.time(), nav=s["nav"], day_ret=s["day_ret"], equity=s["equity"], positions=len(s["positions"]),
                   realized=sum(t["pnl"] for t in trades), n_trades=len(trades), pods=[[n, round(v, 2)] for n, v in pods],
                   best=dict(pod=f.names.get(best["pod"], best["pod"]), sym=best["sym"], pnl=best["pnl"]) if best else None,
                   worst=dict(pod=f.names.get(worst["pod"], worst["pod"]), sym=worst["sym"], pnl=worst["pnl"]) if worst else None,
                   var99=rr.get("var99"), var99_pct=rr.get("var99_pct"), es=rr.get("es"), mode=F["mode"], mult=F["mult"],
                   compliance=cp, models=[dict(name=m["name"], passed=m["passed"]) for m in models_today],
                   ideas=[dict(name=e["name"], passed=e.get("passed")) for e in ideas_today],
                   net_nav=self.strikes[-1]["net"] if self.strikes and self.strikes[-1]["day"] == day else None)
        self.reports.append(rep)
        self.reports = self.reports[-60:]
        await f.say("sam", "report", f"End-of-day report {day}: NAV {s['nav']:.2f} ({s['day_ret']:+.2%}), {len(trades)} trades closed "
                    f"(${rep['realized']:+,.0f}), best pod {pods[0][0] if pods else '—'}. "
                    + (f"99% VaR {rr['var99_pct']:.1%} of NAV. " if rr.get("var99_pct") is not None else "")
                    + f"{len(ideas_today)} research ideas, {len(models_today)} models tested. Full report in Reports.", pause=1)

    async def step(self):
        t = datetime.now(NY)
        if t.weekday() >= 5:
            return
        day = t.strftime("%Y-%m-%d")
        if (t.hour, t.minute) >= (16, 15) and self.strike_day != day:
            self.strike_day = day
            await self.strike(day)
        if (t.hour, t.minute) >= (16, 20) and self.report_day != day:
            self.report_day = day
            await self.eod_report(day)

    def statement(self):
        f = self.f
        gross = f.broker.equity(f.prices())
        pre = gross - self.mgmt_total - self.perf_paid
        perf_now = max(self.perf_accr, PERF * max(0.0, pre - self.hwm))
        net = pre - perf_now
        months = {}
        prev = None
        for r in self.strikes:
            m = r["day"][:7]
            months.setdefault(m, [prev if prev is not None else 100.0, r["net"]])
            months[m][1] = r["net"]
            prev = r["net"]
        return dict(start=C.STARTING_CASH, gross=gross, net=net, gross_ret=gross / C.STARTING_CASH - 1, net_ret=net / C.STARTING_CASH - 1,
                    mgmt=self.mgmt_total, perf=perf_now + self.perf_paid, hwm=self.hwm, hwm_nav=100 * self.hwm / C.STARTING_CASH,
                    terms=f"{MGMT:.0%} management fee, {PERF:.0%} performance fee over a high-water mark (crystallized annually)",
                    monthly=[[m, v[1] / v[0] - 1] for m, v in months.items()], strikes=self.strikes[-30:])

    def snapshot(self):
        return dict(statement=self.statement(), reports=self.reports[-20:][::-1])
