"""Ops desk (the Ops Center tower): is the machine that runs the city healthy?

Cheap, real numbers for a 24/7 server: uptime, how long each floor loop takes, errors caught by the loop, load average,
memory, free disk, and how fresh every data feed is (seconds since its last good update). Nothing here trades; it is
what you'd check first when something looks off."""
import os
import shutil
import time
from collections import deque


def _rss_mb():
    try:                                                   # Linux (the VPS)
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    try:                                                   # Windows / macOS fallback
        import psutil
        return round(psutil.Process().memory_info().rss / 2 ** 20, 1)
    except Exception:
        return None


class Ops:
    def __init__(self, floor):
        self.f = floor
        self.started = time.time()
        self.loops = deque(maxlen=60)                      # seconds per floor loop
        self.errors: deque = deque(maxlen=20)              # (t, text)
        self.feed_t: dict = {}                             # feed -> last good update time

    def loop(self, seconds):
        self.loops.append(seconds)

    def error(self, text):
        self.errors.append((time.time(), str(text)[:160]))

    def fresh(self, feed):
        self.feed_t[feed] = time.time()

    STALE = {"market data": 900, "Alpaca quotes": 900, "Deribit options": 900, "Alpaca broker": 1800, "daily bars": 7200}

    async def check(self):
        """Nova (ops) speaks up when a feed goes stale and when it recovers; Kip when the floor loop gets slow."""
        now, f = time.time(), self.f
        self.alerted = getattr(self, "alerted", {})
        for feed, t in self.feed_t.items():
            lim = self.STALE.get(feed)
            if not lim or (feed == "Alpaca broker" and not (f.alpaca.enabled and f.alpaca.configured and not f.alpaca.killed)):
                self.alerted.pop(feed, None)
                continue
            stale = now - t > lim
            if stale and not self.alerted.get(feed):
                self.alerted[feed] = now
                await f.say("nova", "ops", f"Heads up: the {feed} feed has been silent for {int((now - t) / 60)} minutes. Watching it.", pause=1, ok=False)
            elif not stale and self.alerted.get(feed):
                self.alerted.pop(feed)
                await f.say("nova", "ops", f"The {feed} feed is back. All green.", pause=1, ok=True)
        lp = list(self.loops)[-5:]
        slow = len(lp) == 5 and sum(lp) / 5 > 30
        if slow and now - getattr(self, "slow_said", 0) > 3600:
            self.slow_said = now
            await f.say("kip", "ops", f"The floor loop is slow: {sum(lp) / 5:.0f}s per cycle (normal is under 10s). Something upstream is lagging.", pause=1, ok=False)

    def snapshot(self):
        now = time.time()
        try:
            load = [round(x, 2) for x in os.getloadavg()]
        except (AttributeError, OSError):
            load = None
        try:
            du = shutil.disk_usage(os.path.dirname(os.path.abspath(__file__)))
            disk = dict(free_gb=round(du.free / 2 ** 30, 1), used_pct=round(du.used / du.total, 3))
        except OSError:
            disk = None
        lp = list(self.loops)
        return dict(uptime=int(now - self.started), loop_avg=round(sum(lp) / len(lp), 2) if lp else None, loop_max=round(max(lp), 2) if lp else None,
                    loops=len(lp), errors=[dict(t=t, text=x) for t, x in list(self.errors)[-6:]], error_count=len(self.errors),
                    load=load, cpus=os.cpu_count(), rss_mb=_rss_mb(), disk=disk, host=os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME"),
                    feeds={k: int(now - t) for k, t in self.feed_t.items()}, stale_after=self.STALE)
