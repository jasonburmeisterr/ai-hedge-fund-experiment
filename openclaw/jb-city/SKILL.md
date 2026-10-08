---
name: jb-city
description: Talk to Jason's AI city (JB Capital hedge fund + JB Ventures startup studio) running on this PC at http://127.0.0.1:8000. Use when Jason asks how the fund is doing, wants to message the CIO or the venture studio, or asks what's new on "the Wire".
metadata: {"openclaw": {"requires": {"bins": ["curl"]}}}
---

# JB City (local only)

The app runs on THIS machine at `http://127.0.0.1:8000`. Never call any other host with this skill.
On Windows use `curl.exe` (not the PowerShell `curl` alias).

## Read
- Fund + studio status (one line of text):
  `curl.exe -s http://127.0.0.1:8000/api/status`
- Latest messages on the Wire (the city message board):
  `curl.exe -s "http://127.0.0.1:8000/api/wire?n=10"`
- One message and its reply:
  `curl.exe -s http://127.0.0.1:8000/api/wire/<id>`

## Send a message (only when Jason asks you to)
- To the fund's CIO (questions about performance, risk, positions):
  `curl.exe -s -X POST http://127.0.0.1:8000/api/wire -H "content-type: application/json" -d "{\"to\":\"fund\",\"text\":\"<message>\"}"`
- To JB Ventures (business-idea requests; answered at the studio's next meeting, can take a while):
  same command with `"to":"studio"`.
- If the app has `FLOOR_TOKEN` set, add `-H "x-floor-token: <token>"`.

The POST returns an `id`. The CIO usually answers within a minute: poll `/api/wire/<id>` every ~20 s (max ~3 min)
and relay `reply` to Jason. Studio answers come after its meeting; tell Jason it's queued.

## Rules
- Paper trading only. This channel cannot place trades or change risk settings; tell Jason to use the dashboard.
- Keep replies short for the phone: lead with the answer, then 1-2 key numbers.
