"""JB Capital - AI Trading Floor. Run:  py server.py   then open http://localhost:8000"""
import asyncio
import collections
import contextlib
import json
import os
import time
import webbrowser

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from firm import config as C
from firm.floor import Floor

HERE = os.path.dirname(os.path.abspath(__file__))
clients: set[WebSocket] = set()
events = collections.deque(maxlen=200)
last_snapshot: dict = {}
event_id = 0


async def broadcast(msg: dict):
    dead = []
    data = json.dumps(msg, default=str)
    for ws in clients:
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def emit(ev: dict):
    global event_id
    event_id += 1
    ev["id"] = event_id
    events.append(ev)
    print(f"[{ev['name']:>8}] {ev['text']}")
    await broadcast({"type": "event", "event": ev})


async def snapshot(snap: dict):
    global last_snapshot
    last_snapshot = snap
    await broadcast({"type": "snapshot", "snapshot": snap})


floor = Floor(emit, snapshot)


async def run_floor():
    await emit(dict(kind="system", agent="boss", name="The CIO", text="Morning, team. The fund is open for trading.", t=0))
    while True:
        t0 = time.time()
        try:
            await floor.step()
        except Exception as e:  # keep the floor alive; show the problem in the log
            floor.ops.error(repr(e))
            await emit(dict(kind="chatter", agent="dot", name="Dot", text=f"Something broke: {e!r}"[:120], t=0))
        floor.ops.loop(time.time() - t0)
        await asyncio.sleep(C.LOOP_SECONDS)


@contextlib.asynccontextmanager
async def lifespan(app):
    task = asyncio.create_task(run_floor())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)
class FreshStatic(StaticFiles):
    """Static files that the browser always re-checks (ETag), so a deploy shows up on the next page load."""
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


app.mount("/static", FreshStatic(directory=os.path.join(HERE, "static")), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(HERE, "static", "index.html"), headers={"Cache-Control": "no-cache"})


@app.get("/api/bars/{sym}")
async def bars(sym: str):
    return {"sym": sym, "bars": floor.bars_json(sym.upper())}


@app.get("/api/experiment")
async def experiment():
    """The experiment scoreboard since Day 0 and since the last saved update (the Experiment update window)."""
    return floor.experiment.build()


@app.get("/api/reports")
async def reports():
    """Sam's end-of-day reports, the investor statement and the compliance log (the Reports window fetches this)."""
    return dict(reports=floor.fundops.reports[::-1], statement=floor.fundops.statement(), compliance=floor.compliance.log[::-1][:200],
                risk=floor.riskrep.snapshot())


@app.get("/api/mlab")
async def mlab():
    """The Model Lab in full: every model, its validation, the volatility models (the window fetches this on open)."""
    return floor.mlab.snapshot()


@app.get("/api/digest")
async def digest(since: float = 0):
    """'While you were away': what happened since the dashboard was last open."""
    return floor.digest.build(since)


@app.get("/api/studio/{iid}")
async def studio_item(iid: str):
    return floor.studio.item(iid) or {}


# ── The Wire over HTTP: for Jason's phone (OpenClaw) and any future building ──
def _check_token(request: Request):
    tok = os.environ.get("FLOOR_TOKEN")
    if tok and request.headers.get("x-floor-token") != tok:
        raise HTTPException(401, "bad token")


@app.get("/api/status")
async def status():
    return {"text": floor.status_text(), "wire_open": floor.board.snapshot()["open"]}


@app.get("/api/wire")
async def wire(n: int = 20):
    return {"posts": floor.board.posts[-max(1, min(n, 200)):]}


@app.get("/api/wire/{pid}")
async def wire_post(pid: str):
    return floor.board.get(pid) or {}


@app.post("/api/wire")
async def wire_send(body: dict, request: Request):
    _check_token(request)
    try:
        p = await floor.jason_says(str(body.get("to", "")), str(body.get("text", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": p["id"], "note": "The answer shows up on the Wire; poll GET /api/wire/" + p["id"]}


@app.get("/classic")
async def classic():
    return FileResponse(os.path.join(HERE, "static", "classic.html"))


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    await ws.send_text(json.dumps({"type": "hello", "events": list(events)[-40:],
                                   "snapshot": last_snapshot or floor.snapshot()}, default=str))
    try:
        while True:
            txt = await ws.receive_text()
            try:
                await floor.control(json.loads(txt))
            except (ValueError, TypeError, KeyError):
                pass
    except WebSocketDisconnect:
        clients.discard(ws)


if __name__ == "__main__":
    port = int(os.environ.get("FLOOR_PORT", "8000"))
    if os.environ.get("FLOOR_NO_BROWSER") != "1":
        webbrowser.open(f"http://localhost:{port}")
    uvicorn.run(app, host=os.environ.get("FLOOR_HOST", "127.0.0.1"), port=port, log_level="warning")
