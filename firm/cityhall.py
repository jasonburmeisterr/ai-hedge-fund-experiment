"""City Hall: one view of the whole city. Who's working on what, each tower's key numbers, Wire traffic and system health.

Pure read-only aggregation over the other towers; it never changes anything."""
import time

STAFF_OF = {"studio": {"iris", "theo", "rosa"}, "news": {"nia", "ben", "lux"}, "career": {"cole", "maya", "drew"},
            "study": {"sage", "quinn", "remy"}, "incubator": {"juno"}, "ops": {"nova", "kip"}}
NAMES = {"fund": "JB Capital", "studio": "JB Ventures", "news": "JB Newsroom", "career": "JB Careers", "study": "JB Study Hall",
         "incubator": "JB Incubator", "ops": "JB Ops Center"}


def building_of(agent):
    for b, staff in STAFF_OF.items():
        if agent in staff:
            return b
    return None if agent == "jason" else "fund"


def mins(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}h {sec % 3600 // 60}m" if sec >= 3600 else f"{sec // 60}m"


class CityHall:
    def __init__(self, floor):
        self.floor = floor
        self.started = time.time()
        self.last: dict = {}        # building -> {agent, name, text, t}
        self.count: dict = {}       # "YYYY-MM-DD|building" -> events
        self.last_step = time.time()

    def note(self, agent, name, text):
        b = building_of(agent)
        if not b or not text:
            return
        self.last[b] = dict(agent=agent, name=name, text=str(text)[:160], t=time.time())
        k = time.strftime("%Y-%m-%d") + "|" + b
        self.count[k] = self.count.get(k, 0) + 1

    def snapshot(self, s):
        f, now, today = self.floor, time.time(), time.strftime("%Y-%m-%d")
        st, nw, cr, sy = s["studio"], s["news"], s["career"], s["study"]
        active = [p for p in s["roster"] if p["status"] == "active"]
        nxt_test = next((t for t in sy["tasks"] if t["test"] and t["days"] >= 0), None)
        b = [
            dict(id="fund", working=bool(s["positions"]) or s["research"]["status"] != "idle",
                 status=("lab: " + s["research"]["status"]) if s["research"]["status"] != "idle" else f"{len(s['positions'])} positions open",
                 kpis=[("NAV / unit", f"{s['nav']:.2f}"), ("Today", f"{s['day_ret']:+.2%}"), ("Active pods", len(active)),
                       ("Next lab session", mins(s["research"]["next_in"]))]),
            dict(id="studio", working=st["status"] != "idle", status=st["status"],
                 kpis=[("Greenlit", st["counts"].get("GREENLIT", 0)), ("Watchlist", st["counts"].get("WATCHLIST", 0)),
                       ("Killed", st["counts"].get("KILLED", 0)), ("Next meeting", mins(st["next_in"]))]),
            dict(id="news", working=nw["status"] != "idle", status=nw["status"],
                 kpis=[("Stories (48h)", nw["count"]), ("Next briefing", mins(nw["next_brief_in"])),
                       ("Lead", (nw.get("brief") or {}).get("headline", "—")), ("Feeds down", len(nw["errors"]))]),
            dict(id="career", working=cr["status"] != "idle", status=cr["status"],
                 kpis=[("Follow-ups due", len(cr["due"])), ("Next event", f"{cr['events'][0]['title'][:14]} {cr['events'][0]['days']}d" if cr["events"] else "—"),
                       ("Opportunities", len(cr["opps"])), ("Zetamac", cr["zetamac"]["last"] if cr["zetamac"]["last"] is not None else "—")]),
            dict(id="study", working=bool(sy["busy"]), status="writing a quiz" if sy["busy"] else "idle",
                 kpis=[("Streak", f"{sy['stats']['streak']}d"), ("Review due", sy["stats"]["review_due"]),
                       ("Next test", f"{nxt_test['title'][:14]} {nxt_test['days']}d" if nxt_test else "—"), ("Answered", sy["stats"]["answered"])]),
        ]
        inc, ops = s.get("incubator") or {}, s.get("ops") or {}
        items = inc.get("items", [])
        act = [x for x in items if x["status"] == "incubating"]
        best = max(act, key=lambda x: x["fwd"]["pf"] if x["fwd"]["n"] else 0, default=None)
        b.append(dict(id="incubator", working=bool(act), status=f"{len(act)} strategies incubating" if act else "empty",
                      kpis=[("Incubating", len(act)), ("Graduated", sum(x["status"] == "graduated" for x in items)),
                            ("Dropped", sum(x["status"] == "dropped" for x in items)),
                            ("Best forward", f"{best['name'][:12]} PF {best['fwd']['pf']:.2f}" if best and best["fwd"]["n"] else "—")]))
        lim = ops.get("stale_after") or {}
        stale = [k for k, a in (ops.get("feeds") or {}).items() if a > lim.get(k, 900)]
        b.append(dict(id="ops", working=True, status="all green" if not stale and not ops.get("error_count") else f"{len(stale)} stale feeds, {ops.get('error_count', 0)} errors",
                      kpis=[("Uptime", mins(ops.get("uptime", 0))), ("Loop", f"{ops['loop_avg']}s" if ops.get("loop_avg") is not None else "—"),
                            ("Memory", f"{ops['rss_mb']} MB" if ops.get("rss_mb") else "—"), ("Stale feeds", len(stale))]))
        wire = s["wire"]
        for x in b:
            x["name"] = NAMES[x["id"]]
            x["last"] = self.last.get(x["id"])
            x["events_today"] = self.count.get(today + "|" + x["id"], 0)
            x["inbox"] = wire["open"].get(x["id"], 0)
        routes = {}
        for p in f.board.posts:
            if now - p["t"] < 86400:
                r = f"{NAMES.get(p['frm'], 'Jason').replace('JB ', '')} → {NAMES.get(p['to'], 'Jason').replace('JB ', '')}"
                routes[r] = routes.get(r, 0) + 1
        issues = []
        if not s["analyst_on"]:
            issues.append("AI brain is off")
        if now - self.last_step > 300:
            issues.append(f"main loop hasn't run for {mins(now - self.last_step)}")
        issues += [f"news feed: {e}" for e in nw["errors"]][:2]
        for name, err in (("career", cr.get("error")), ("study", sy.get("error")), ("GEX", s.get("gex", {}).get("error"))):
            if err:
                issues.append(f"{name}: {err}")
        bl = s.get("broker_link") or {}
        if bl.get("killed"):
            issues.append(f"broker kill switch: {bl['killed']}")
        return dict(buildings=b, routes=sorted(routes.items(), key=lambda kv: -kv[1]),
                    health=dict(ok=not issues, issues=issues, uptime=mins(now - self.started), brain=s["brain"], feeds=s.get("feeds", {}),
                                last_loop=int(now - self.last_step)))
