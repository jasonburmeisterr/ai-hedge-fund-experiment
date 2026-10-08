"""The Wire: the city-wide message board that turns the towers into one ecosystem.

Every building (an agent org) posts to the board and reads its own inbox:
  - a post goes FROM a building/agent TO a building (or to Jason) with a topic
  - the 3D city shows each post as a courier: robots walk the sky bridge, drones fly to far buildings
  - Jason posts requests from the dashboard or his phone (OpenClaw -> POST /api/wire); the target building answers
New buildings plug in by adding themselves to BUILDINGS and reading `board.inbox("<their id>")`."""
import time

BUILDINGS = {
    "fund": "JB Capital",
    "studio": "JB Ventures",
    "news": "JB Newsroom",
    "career": "JB Careers",
    "study": "JB Study Hall",
    "jason": "Jason",            # the founder: his dashboard + phone
}
OPEN, DONE = "open", "done"


class Board:
    def __init__(self, floor, posts: list | None = None):
        self.floor = floor
        self.posts: list = posts or []
        for p in self.posts:             # a restart mid-meeting: put half-done requests back in the inbox
            if p["status"] == "working":
                p["status"] = OPEN

    def to_state(self):
        return self.posts[-200:]

    async def post(self, frm, agent, to, topic, text, data=None, emit=True):
        """Send a message across the city. `frm`/`to` are building ids, `agent` is who carries it."""
        if to not in BUILDINGS:
            raise ValueError(f"unknown building {to!r}")
        p = dict(id=f"w{time.time_ns()}", t=time.time(), frm=frm, agent=agent, to=to, topic=topic,
                 text=str(text)[:600], data=data or {}, status=OPEN, reply=None, replied_by=None, replied_t=None)
        self.posts.append(p)
        self.posts = self.posts[-200:]
        if emit:
            await self.floor.say(agent, "wire", f"[{BUILDINGS[frm]} -> {BUILDINGS[to]}] {p['text']}"[:260],
                                 frm=frm, to=to, topic=topic, post=p["id"])
        return p

    async def reply(self, p, agent, text):
        p.update(status=DONE, reply=str(text)[:1500], replied_by=agent, replied_t=time.time())
        await self.floor.say(agent, "wire", f"[{BUILDINGS[p['to']]} -> {BUILDINGS[p['frm']]}] {p['reply']}"[:260],
                             frm=p["to"], to=p["frm"], topic=p["topic"], post=p["id"], reply=True)

    def ack(self, p, agent):
        """Mark a note as read without sending a courier back."""
        p.update(status=DONE, replied_by=agent, replied_t=time.time())

    def inbox(self, bldg, topic=None, status=OPEN):
        return [p for p in self.posts if p["to"] == bldg and (topic is None or p["topic"] == topic)
                and (status is None or p["status"] == status)]

    def recent(self, n=8, exclude_to=None):
        return [p for p in self.posts if p["to"] != exclude_to][-n:]

    def get(self, pid):
        return next((p for p in self.posts if p["id"] == pid), None)

    def snapshot(self):
        return dict(buildings=BUILDINGS, posts=self.posts[-40:],
                    open={b: len(self.inbox(b)) for b in BUILDINGS})
