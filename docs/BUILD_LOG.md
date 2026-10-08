# JB Capital — AI Hedge Fund (paper)

An AI-run multi-strategy hedge fund (equities, futures, crypto and options), shown as a realistic trading floor staffed by humanoid trading robots on top of a city tower (sky, sun and lights follow your local time), inside a fund-terminal UI. AI agents analyze live market data and paper-trade,
and you can watch every step: ideas walked into the Boss's office, Rex stamping APPROVED / VETO,
Eddie running orders to the Exchange door, Sam grading every call.

**Paper trading only. No real money is ever touched.**

## The 3D floor (v10)
- **The trading hall** is 56 x 34 m with 8 m glass walls: a giant video wall (markets heatmap, NAV, PM board with each pod's
  allocation and risk dial), every portfolio manager in the front row at a **pod station** (a rug in the pod's color + a
  floating sign with live P&L, capital and risk per trade), research/analytics/risk & execution behind them, the CIO's
  corner office, a conference room, a lounge by the windows and the quant research lab (with a Quant Toolbox board).
- **Game mode** (button or **G**): the floor fills the screen, with a live story feed, a strip of every agent in the
  building (P&L + what they're doing) and a card for the one you follow. It remembers your choice; **Esc** leaves it.
- **Getting around**: **Go to ▾** jumps to any room or building · **Tab** / Shift+Tab cycles agents in the building ·
  **Space** follows on/off · **1-7** buildings · **H** home · right-drag turns the camera without dropping the follow ·
  **?** shows every control. Hooks: `?game`, `window.__jb.route([x,z],[x,z])` (walking route debug).
- **Walk mode** (v11, **C** toggles walk / drone; default in game mode): you are the gold robot. WASD walks relative to
  the camera, Shift runs, Space hops, drag orbits, scroll zooms; click the floor to walk there (across the sky bridges
  too), click a robot or press **Tab** to walk over and talk, **E** talks to or uses what's in front of you (CIO desk,
  video wall, lab, elevator fast travel, boards in every tower, coffee). Collision comes from an occupancy grid built
  from the furniture at startup. **1-5, 8, 9** fast-travel between towers; **Daily rounds** (talk to every PM, Rex, the
  CIO, visit the lab and the video wall) are saved per day. Hooks: `?walk`, `window.__jb.walk`.
- **Seven towers** on the sky-bridge row: Ops Center · Study Hall · Newsroom · **JB Capital** · Ventures · Careers ·
  Incubator. The **Incubator** is a greenhouse where every strategy in the shadow book is a trainee robot with its
  forward record above its desk; graduates walk across the bridges to the trading floor. The **Ops Center** is mission
  control (system, data feeds, broker & risk screens, server racks, a turning radar) staffed by Nova and Kip.
- **Games for you** (practice, no money): the **Mental Math Arena** (an arcade cabinet in the Study Hall: a Zetamac-style
  120-second + − × ÷ drill, best score and history saved, Quinn announces runs) and **Beat the Bots** (a kiosk in the fund
  lounge: call whether SPY / QQQ / BTC / GLD / TLT will close above or below the price right now; Sam grades it at the next
  daily close against Ava's view and a 20-day trend bot; `firm/arena.py`). A gold crown floats over the **PM of the week**
  (best 7-day live P&L); daily rounds keep a streak; optional synthesized sound cues (🔇 button).
- **City tour** (Go to ▾ → ▶ City tour, or `?tour`): a cinematic fly-through of all seven towers with captions and
  letterbox bars, made for a screen recording (LinkedIn, the career fair). Esc or a click stops it.
- A holographic ticker ring turns over the trading hall; fireworks go up over the city on a new all-time high and when
  a strategy graduates (test hook `?fireworks`).

## Things you can do on the floor (v14)
Walk up and press E, or use the Go-to menu:
- **Your desk** (gold, end of the PM row): trade alongside the AI PMs. Pick a market, direction, risk (0.25-1% of NAV),
  stop (1-3 daily ATRs), trailing on/off and a holding limit. Rex sizes it inside the same fund limits every PM has and
  says which limit bound; Eddie fills it and runs the stops. Close it or move the stop to breakeven any time. A scoreboard
  compares your average R per trade with the AI PMs'. Your trades are in the books but never train the AI (`firm/mydesk.py`).
- **Ask anyone**: every agent's card has a question box. They answer in character from their OWN live numbers (a PM: its
  pod, strategy, risk dial, positions, lessons; Rex: the risk book; Ava: the lab; the CIO: the fund) (`firm/askdesk.py`).
- **Strategy Builder** (the lab's backtest station): snap 1-3 lego blocks together, set exits and markets, and get the
  lab's real verdict on 10+ years of daily bars. Your tests count toward the multiple-testing bar like Ava's. A pass can
  go to the incubator and get hired as a PM if it proves itself forward (`firm/builder.py`).
- **Stress test** (Rex's desk, or the Risk tab): shock the live book (equity crash, crypto winter, rate shock, oil spike,
  melt-up, or custom) and see the loss per pod with stops holding vs prices gapping through them.
- **Fund tear sheet** (the NAV screen on the video wall): NAV, Sharpe/Sortino (after 20 days), drawdowns, beta to SPY,
  monthly returns grid, P&L attribution by pod / asset group / market. Printable (`firm/tearsheet.py`).
- **The opening bell** (between the PM desks): rings itself at 9:30 and 4:00 New York time; ring it yourself with E.
- **While you were away**: open the dashboard after 2+ hours and it summarizes what happened since: NAV change, closed
  trades by pod, new positions, hires/fires/incubator moves, research passes, Rex's risk flags (`firm/digest.py`, `/api/digest`).
- **Market Making Pit** (Study Hall, next to the Math Arena): quote a bid/ask on the sum of four hidden dice; Quinn sees one
  die more than you and picks off bad prices, two uninformed customers pay the spread. Centered quotes ~2.5 wide average
  about +12 over five games; a 1-point market loses. The classic SIG / Jane Street interview game.
- **Opal's options book** (the screen between Opal's and Rita's desks): payoff at expiry and today (Black-Scholes at each
  leg's IV), breakevens, max profit/loss, chance of profit, and a "what if it moves X%" slider.
- **Trophy case** (next to your desk): 21 achievements for trading, research, games, streaks and fund milestones.

## Running like a real firm (v18)
- **Compliance (Lena, `firm/compliance.py`)**: every order (PMs, Opal, models, yours) is checked before Rex sizes it:
  restricted list (you control it), single-stock earnings blackout (Yahoo dates), wash-sale flags; full log; 4:30 pm
  attestation.
- **Risk report (Rex, `firm/riskreport.py`)**: historical-simulation VaR 95/99 and expected shortfall of today's book over
  500 real trading days, factor exposures ($ per 1% move in stocks, bonds, gold, oil, bitcoin), standalone VaR by pod.
- **Fund operations (`firm/fundops.py`)**: official NAV struck at 4:15 pm with shadow 2-and-20 fees over a high-water mark
  (gross vs net), Sam's end-of-day report at 4:20 pm (archived), investor statement (Reports window, `/api/reports`).
- **Morning meeting** at 9:00 New York time: the team gathers; CIO plan, Rex's VaR, Ava's research, Kai's models, Lena.
- **Risk policy presets** on the CIO desk: Pod shop (recommended, now live), Aggressive paper, Max.
- **The space**: a reception lobby by the elevator (logo wall, Ari at the front desk with your briefing, waiting seats),
  a holographic market globe, six-screen trading desks with Bloomberg-style terminals, Lena's compliance desk, phone
  booths, a real ceiling while you're inside, aisle lights that glow green/red with the day's P&L.
- **Walking**: WASD only (no click-to-walk), V for first person, and the third-person camera stops in front of walls.

## Quant research: models, volatility models, honest validation (v17, `firm/quant/`)
- **Kai, the ML quant researcher** (analyst row, Model Lab board behind his desk) develops forecasting MODELS, not just
  rules: a hypothesis, features from a vetted library (28 look-ahead-free, volatility-scaled features: momentum,
  reversal, volatility, cross-sectional ranks, market context like credit spreads and the VIX term structure), a horizon
  (1/5/21 days), a learner (ridge, logistic, gradient-boosted trees, ensemble) and a style (cross-section or timing).
- **Validation like a real quant shop** (`validate.py`): walk-forward retraining every quarter with a purge + embargo gap;
  daily information coefficient with Newey-West t-stats; a permutation null (randomly time-shifted forecasts); a
  vol-scaled portfolio with real per-market costs and turnover; alpha versus buy-and-hold; IC positive in most years; a
  SEALED 2-year holdout never used for selection; the multiple-testing bar rises with every model; then the forecasts
  must survive the real stops/exits (traded PF >= 1.1). A planted 0.05-correlation signal passes; the starter ideas fail.
- Passing models are hired (or incubated) as PMs with family `model` and trade their live forecasts (extended daily)
  through the CIO, Rex and Eddie. You can build and test your own model in the Model Lab window.
- **Volatility models** (`vol.py`): HAR-RV(-IV) forecasts of next month's realized vol (Garman-Klass), scored out of sample
  versus last month's vol and implied vol; an iron-condor backtest on 18 years of CBOE implied vol (VIX/VXN/GVZ/OVX) and
  Deribit DVOL, with skew, 6% bid-ask costs and Opal's live management rules. Tiers: MODEL (sell when IV / forecast >= k),
  PREMIUM (selling pays, timing doesn't), NONE (stand aside). Today: SPY + BTC model, ETH premium, QQQ/GLD/USO none.
- **Opal's ETF options desk** (`voldesk.py`): live SPY/QQQ/GLD/USO iron condors from the Alpaca chain, only on validated
  tiers. Futures options need an Interactive Brokers account or paid CME data (Alpaca has no futures).
- **Beat random, not zero** (`backtest.random_baseline`): new rule strategies must beat random entry days with the same
  exits, costs and mix. Existing PMs that don't are certified as "beta, not alpha" and trade at half size (today: Mo,
  Vega, Ivy, Quinn; Rita's entries genuinely beat random, t=3.4).

## Your office (v17)
NW corner: walnut desk with live screens (the founder's hub to every control), the quant reading list on the bookshelf,
the Founder's board with your priorities, the JB TV. Go to -> Your office. The floor got a navy carpet, oak walkways,
linear lights, a JB medallion, hanging signs, plants and art.

## The CIO (v16): a decision-maker, and your controls over the floor (`firm/cio.py`)
- **Trade reviews.** Every PM signal gets PASS or a size multiplier with reasons: the fund's risk mode, your mandate, the
  PM's form (on watch 0.5x, star 1.15x, your boost 1.25x), book fit (piling into a group already 35%+ of NAV: 0.75x;
  diversifying: 1.1x) and Ava's view. Capped at 1.6x and at the CIO's max risk per trade.
- **Risk mode.** Drawdown from the high-water mark: normal; defensive at -3% (0.5x); capital preservation at -6% (0.25x,
  only trusted PMs); back to normal above -1.5%. Fund vol targeting (15%) scales new risk 0.6x-1.5x once there are 10 days.
- **Performance reviews** every 6 hours: live R per trade vs the backtest's promise. 2 standard errors worse -> on watch
  (half size) and first in line at the lab; 2 better -> star.
- **Morning plan** at 9:00 New York time (or "Write today's plan" in the console).
- **CIO console** (the CIO's desk): risk mode, the plan, watchlist, every decision with its outcome, and a scorecard of
  whether the CIO's sizing added money versus trading everything at full size.
- **Floor announcements** from the podium in front of the NAV wall: the floor stops and turns to listen. Directives:
  risk stance until the close (defensive 0.5x / normal / press 1.25x), pause new entries (1 hour / until the close), a
  research sprint (a lab session every 20 minutes for 24 hours), an all-hands huddle. The text becomes a standing
  priority for 7 days: it goes into Ava's research brief, the team's reflections and pitches, what agents answer when
  asked, and the morning plan. Directives are suggested from your words as you type ("prioritize finding an edge" ->
  research sprint), and you can toggle them before sending.
- **Manage the team**: shout-out (morale + XP, the floor claps), warn (on watch for 5 days), boost (1.25x for 5 days),
  send to the lab (first in line for Ava), bench / unbench, fire (two clicks).

## Run it
Double-click `run.bat` (or the Desktop shortcut). The game opens at http://localhost:8000.
- Drag to rotate, right-drag to pan, scroll to zoom.
- Click a person: the camera follows them, and you see their stats, what they said, and a BENCH button.
- Click the Boss's desk: live firm settings (risk per trade, total risk, conviction, max positions) and the bench.
- Click the whiteboard: live candle charts. Click the EXCHANGE door: trade history.
- DEMO TRADE button (or press D): watch a fake trade play out. The old 2D version is at /classic.

## How the fund works (multi-manager "pod" model)
- Every quant is a **Portfolio Manager (PM)** running a **pod**: own capital, own trades, own P&L (positions are keyed pod|symbol).
- **The CIO** allocates capital to pods in proportion to earned trust (5%–45% each). Paused/stopped pods get 0.
- **Rex, the CRO**, sizes every trade (pod risk per trade × pod capital), enforces the fund-wide risk cap, and shuts down any pod
  that falls `POD_DD_LIMIT` (8%) of its capital below its peak P&L — the classic pod-shop rule.
- **Rex's risk book** (`firm/riskbook.py`): pods can't see each other's books, so Rex enforces limits on the WHOLE fund:
  one market at most 25% of NAV and one group of look-alike markets (US stocks, bonds, metals, crypto...) at most 50%,
  across all pods. New trades only get the room that's left; a book more than 10% over a limit is trimmed pro rata at the
  open; trims stop as soon as the excess is covered, and one micro future alone in its group is always allowed (the
  smallest possible bet). (Built after Mo, Vega and Quinn all bought SPY on the same day and the fund ended up 75% in one ETF.)
- The CIO divides each pod's trust by how many teammates make the same bet (Dot's correlation report), so a cluster of
  look-alike trend PMs shares one budget and genuinely different strategies get more capital.
- **The Quant Toolbox** (`firm/toolbox.py`, `firm/montecarlo.py`; R&D tab): four research tools per PM on 10+ years of data:
  a **Monte Carlo** risk lab (3,000 reshuffled years per pod, losing streaks kept together: odds of hitting the pod's
  drawdown stop, return cone, Kelly point), a **robustness** test (every setting nudged ±15%/±30%: does the edge survive
  next door?), a **crisis test** (COVID, 2022, the 2025 tariff shock...) and a **factor X-ray** (beta to SPY/TLT/GLD/BTC,
  alpha t-stat), plus (`firm/overfit.py`) an **overfitting check** (the deflated Sharpe ratio of each pod after the
  number of independent ideas the lab has tested, and the probability of backtest overfitting of the lab's whole
  selection process via CSCV) and **alternate histories** (each strategy re-run on 16 made-up decades: real bars
  reshuffled in 3-month blocks, all markets cut at the same dates). The agents read the results in their team reflections.
- **The Incubator** (`firm/incubator.py`, the greenhouse tower): strategies that pass the lab while every desk is full
  trade a shadow book with no capital. Only trades opened after admission count. 8+ forward trades with PF 1.3+ =
  graduation (a free desk, or replacing the weakest hire if it did better forward than that hire did live). It holds 12;
  a newcomer only displaces one without a record if its backtest PF is 0.3+ better or that one has been idle 45+ days;
  16 forward trades without PF 1.3, or 240 days without graduating, retires a strategy.
- **Margin** (`MAX_GROSS`, 1.0x-2.0x at the CIO desk, default 1.0 = cash only): stocks/ETFs/crypto can be held up to that
  multiple of NAV; borrowed cash pays `MARGIN_RATE` interest daily. The per-market and per-group limits still apply.
- **Ops desk** (`firm/ops.py`, the Ops Center tower): uptime, loop timing, errors, memory, load, disk and the age of
  every data feed; Nova speaks up when a feed goes stale.
- **The CIO's risk dial**: each pod's risk per trade = the Monte Carlo pick (risk appetite x Kelly, never past a
  stop-out limit of 20% x appetite per year), less for fragile edges, capped so the worst real crisis fits inside the
  pod's drawdown stop, halved when a pod is halfway to its stop. Backtest edges are haircut 50%; live trades take over
  as they come in. Sliders at the CIO desk: risk appetite, max risk per pod, starting risk for unproven pods.
- Fund metrics: NAV per unit (starts at 100), Sharpe and volatility (after 24h of data), max drawdown, gross/net exposure.
- **Investor letters**: once a day the CIO (Claude via your Max plan) writes an honest update. "Write letter now" in the Letters tab.

## Options desk (Opal)
Live BTC/ETH option chains from Deribit (free public API). Fills at the real bid/ask, Deribit-style fees, Black-Scholes greeks
from each option's implied vol. Implied vol / realized vol >= 1.20 -> sell an iron condor (short ~20-delta, long ~7-delta wings,
defined risk); <= 0.90 with momentum -> buy an ATM call/put. Exits: condor at 50% of max profit, stop at 1.5x credit, close a day
before expiry; long options at +100% / -50%. Opal is graded on trade results, so the CIO allocates to her like any other pod.

## Teamwork & adaptation
- Team huddle every 45 min at the holo table: CIO (NAV, best/worst pod), CRO (risk), Opal (vol), Ava (research), new allocations.
- The R&D lab alternates: invent a new PM, then **retrain the weakest PM** (stopped-out pods first). An upgrade must pass the
  out-of-sample bar AND beat the current version; upgraded PMs get a fresh track record and are reactivated.
- Rex walks to desks to check stops, Ava visits weak PMs, Dot maintains the data pipeline, Vic watches the wall.

## The team
| Agent | Job | How |
|---|---|---|
| Dot | Data clerk | Coinbase crypto (real time) + Yahoo stocks/futures (~15 min delayed), every minute |
| Mo | Momentum quant | Breakout above the 20-bar high while above the 50 EMA (or the mirror image) |
| Rita | Mean-reversion quant | Fades moves stretched more than 2 std devs from the 20-bar average |
| Vic | Volatility | ATR rank: "storm" = half size |
| Ava | AI analyst (Claude) | Reads every market every 30 min, gives a bias per symbol. Off until enabled |
| The Boss | Portfolio manager | Trust-weighted vote of the calls; trades if strong enough |
| Rex | Risk | 1% risk/trade, 5% total open risk, size caps, can VETO |
| Eddie | Execution | Paper fills with slippage + commission, stops, trailing stops, time stop |
| Sam | Scorekeeper | Grades every call 1 hour later. **Trust is earned from results** |

## The point: does anything actually have an edge?
Sam's skill board is the honest test. An agent's trust only moves after 10+ graded calls,
and it goes up only if its calls make money on average. Before ever trading real money:
- at least a few hundred graded calls,
- positive edge **after** fees in the P&L, not just a good hit rate,
- results that hold up across weeks, not one lucky day.

## Ava's brain (Claude)
By default Ava runs through **Claude Code in headless mode, using your Claude Max plan** (`FLOOR_LLM=claude-code`):
no API key, no extra cost, but it uses your Max usage limits (about 1 research session + 1 market report per hour).
To use a pay-as-you-go API key instead: `set FLOOR_LLM=claude` and `set ANTHROPIC_API_KEY=sk-ant-...` in `run.bat`.
`FLOOR_LLM=off` turns Ava off. Tuning: `FLOOR_RESEARCH_MIN` (60), `FLOOR_ANALYST_MIN` (60), `FLOOR_MODEL` (API mode only).

## The R&D lab (how the firm gets smarter)
Every hour Ava reads `firm/playbook.md` (documented market effects + rules against fooling yourself), the team's live
scorecard and the research log, then proposes 2 new strategies from a safe library (breakout, mean reversion, time-series
momentum, each with volatility/direction filters). The backtest machine replays ~60-90 days of 15-minute bars with fees
and slippage; the last 40% is **out-of-sample**. Pass = OOS profit factor >= 1.15, >= 15 OOS trades, positive, and no
in-sample loss. Winners get **hired** (up to 3 desks); hires whose live trust drops below 0.6 after 15 graded calls get
**fired**; founders Mo/Rita get auto-benched if their live edge is bad. Click the lab board or press R&D LAB for the log,
and RESEARCH NOW to trigger a session.

## The city & The Wire (how the towers work together)
The fund (JB Capital) and the studio (JB Ventures) are joined by a glass **sky bridge**. Above it hangs **The Wire**,
the city message board (`firm/city.py`). Every building posts to it and reads its own inbox:
- after each huddle, Ava walks the bridge with a **fund brief** for JB Ventures (Iris reads it at the next studio meeting)
- when the studio **greenlights** an idea, Rosa walks it over to the CIO, and a drone carries it up to you
- **you** can message any tower from the **Wire** tab, or from your phone through OpenClaw: the CIO answers fund
  questions within a minute; the studio turns requests into researched ideas at its next meeting
- new buildings plug in by adding themselves to `BUILDINGS` in `firm/city.py` and reading `board.inbox("<id>")`

**JB Newsroom** (`firm/newsroom.py`, the tower west of the fund): Ben (markets/crypto) and Lux (AI/tech) pull free RSS feeds
every 10 min (CNBC, Yahoo Finance, CoinDesk, Cointelegraph, TechCrunch AI, The Verge AI, Hacker News; no keys) and tag
headlines with the fund's symbols. Every hour Nia writes a briefing: market news → the fund (Ava reads it in her market
report), AI/startup trends → JB Ventures (Iris reads them when scouting), and a real shock → you (max one ping per 6h,
AI briefings only). Without the AI brain she sends a plain keyword digest. Ask her on the Wire: "what's the news on oil?"

**Data feeds:** crypto real time (Coinbase) · stocks/ETFs real time via Alpaca's free IEX feed (needs the Alpaca keys in
`.env`; otherwise ~15 min delayed Yahoo) · futures ~10 min delayed (Yahoo; real-time CME data costs money) · options live
(Deribit). Hover the market pills in the header to see each feed. Bars/history still come from Yahoo + Coinbase.

**Real-time news:** with Alpaca keys Ben reads Benzinga's wire every minute. A story about a market the fund holds goes
straight to Rex, who reports the exposure and stops. Information only: nobody trades on headlines.

**GEX desk (Vic, `firm/gex.py`):** dealer gamma exposure from real open interest: BTC/ETH live from Deribit, SPY/QQQ
from CBOE's free delayed chains (open interest is only published once a day anyway). Shows GEX per 1% move, the gamma
flip, call/put walls and gamma by strike (Risk tab). It is an ESTIMATE, so it is **not used for trading**: Vic
forward-tests whether negative-gamma days really move ≥1.3× more than positive-gamma days (one non-overlapping
observation per market per day, ≥15 each side) before it could ever touch sizing, and that switch would be yours.

**JB Study Hall** (`firm/study.py`, the library tower west of the newsroom): reads your classes + Canvas tasks from JB
Terminal (read-only). Sage posts a small daily plan at 8 AM (quick win first, ~55 min total, no guilt). Quinn writes
5-question practice rounds for what's due (or any topic you type), grades them in the Study tab, and keeps a
spaced-repetition deck (missed questions come back tomorrow, Leitner boxes). Ask Remy anything on the Wire, or send
"quiz me on ..." to the Study Hall. Due-date extensions live in the Study Hall, never written back to JB Terminal.

**Earned upgrades** (`firm/unlocks.py`, top of the R&D tab): paid tools the team must EARN before you buy them.
First up: real-time CME futures data, earned at ≥20 closed futures trades, profit factor ≥1.2 after costs, net
profit, and ≥30 days. When it's earned, the CIO tells you on the Wire; nothing is ever bought automatically.

**City Hall** (`firm/cityhall.py`, the domed building on the plaza): one view of the whole city. Click it or the
**City Hall** button: health (AI brain, data feeds, loop, kill switch), every tower's status and key numbers, who did
what last, events today, Wire inboxes, and Wire traffic over 24h. A giant status board floats over the plaza.

**The campus:** no filler city any more. Just our five towers (study | news | fund | studio | careers) on a waterfront
plaza: a boulevard with traffic, trees, lawns, a bay and hills. Each tower has real architecture (`tower()` in
game3d.js): a lit lobby with piers and a canopy, floor slabs, fins on the glass towers, a classical portico on the
study hall, and a crown with a lit accent band. Preview other times of day with `?tod=day|dusk|night`.

**JB Careers** (`firm/career.py`, the tower east of JB Ventures): reads your JB Terminal file READ-ONLY (contacts,
follow-up dates, events, Zetamac). Cole posts a 7 AM standup to you; Drew drafts follow-up messages and a career-fair prep
sheet (pitch, booth questions, checklist) when a fair is within 7 days. **Drafts only: you send everything yourself.**
Maya scouts early programs/internships on the web once a day. The newsroom forwards headlines about firms on your list.
Personal notes are never sent to the AI; reports land in `career_reports/` (gitignored).

HTTP API (local only): `GET /api/status`, `GET /api/wire?n=20`, `GET /api/wire/<id>`, and
`POST /api/wire {"to": "fund"|"studio"|"news"|"career", "text": "..."}`. Set `FLOOR_TOKEN` to require an `x-floor-token` header on POST.

**Phone control (OpenClaw):** once OpenClaw works, copy `openclaw/jb-city/` into `~/.openclaw/skills/` and restart the
gateway. Then text your bot "how's the fund doing?"

The city itself is a 40-unit street grid with a river, parks, traffic and a distant skyline. All static city meshes
are merged per material (a few dozen draw calls in total), so it stays fast.

## Files
- `server.py` — web server + the loop that runs the floor every minute
- `firm/config.py` — every setting (markets, risk rules, thresholds)
- `firm/floor.py` — what each agent does
- `firm/data.py` — price feeds + indicators · `firm/broker.py` — paper broker · `firm/scorekeeper.py` — Sam · `firm/analyst.py` — Ava
- `static/` — the game: `index.html` + `game3d.js` (3D), `classic.html` + `classic.js` (old 2D)
- `state.json` — the firm's saved money/positions/scores (delete it to restart from $100k)

## Ideas for next levels
Multiple strategies per desk, news feed for Ava, sound effects, a "hire/fire" screen,
Alpaca paper account for stocks, backtest mode that replays history at 100x speed.

## Living agents (minds + lego kit)
- `firm/minds.py`: every agent has a personality, memories (trades, research verdicts, hires/fires, promotions), XP and a
  career ladder (Rookie → Partner), a mood, a goal and a journal. Every 8h the team **reflects** (one Claude call):
  journal entries, evidence-based lessons, new goals, up to 2 **strategy pitches** and at most 1 **tool request** to Jason
  on the Wire. Lessons and the lego-block track record feed every research session, so knowledge compounds.
- `firm/blocks.py`: the lego kit. Agents invent brand-new strategies (family `custom`) by combining 1-3 vetted blocks
  (trend, ma_cross, momentum, new_high, dip, rsi_extreme, rsi_strong, streak, range_pos, calm, gap, pullback).
  No AI-written code ever runs; every pitch faces the same strict backtest bar before it trades.
- A PM whose invention passes and clearly beats their current strategy (or who is benched/stopped) switches to it;
  otherwise it becomes a new hire that the inventor mentors. Minds never touch orders, sizing or risk limits.
- Team tab in the dashboard; `?open=team` test hook; "Reflect now" button.

## Trial and error + the Study Hall library
- `firm/trials.py`: every ~12 min a PM walks to the backtest machine and tries 4 changes to the factors of their OWN
  strategy (tweak a setting, exits, add/drop/swap a lego filter, drop worst market, add a market, direction, volatility
  filter, or a Study Hall idea). Which kind of change to try is learned per PM (Thompson sampling on their own win/loss
  record, with the firm's shared record as a prior). A change sticks only if it improves the training years AND holds up
  on the last 3 years, passes the full hiring bar, and doesn't cut returns; max one upgrade per PM per day. Classic
  families can now carry `extra` lego filters.
- `firm/library.py`: every ~75 min an agent walks to the JB Study Hall reading table and reads real material with
  Claude + web search (classic quant papers, live arXiv q-fin RSS, business essays for the studio staff). Notes, cited
  sources and a lesson are saved; PMs bring back one concrete experiment that jumps their trial queue. Studio staff's
  reading feeds JB Ventures meetings.
- Team tab: live experiments, library notes with source links, per-PM "what works for me" record;
  buttons Experiment now / Send someone to read. ws controls: experiment_now, read_now.

## Dot's correlation & overlap report
`firm/overlap.py` (built from Dot's tool request on the Wire): backtests every active daily PM, then reports weekly
mark-to-market return correlation, position overlap (same market, same direction), the effective number of independent
bets (N² / Σcorr), clusters (corr ≥ 0.6 or ≥ 75% same positions) and markets doubled up right now. Refreshes every 6h or
when any strategy changes; Rex flags clusters; the line feeds the lab brief and the team's reflections. Risk tab heatmaps.
Info only: it doesn't change sizing.

## Stock & ETF options for every PM (`firm/stockopts.py`)
Daily PM signals on optionable US ETFs/stocks can be expressed as **shares** or a **debit vertical spread**
(long ~0.55Δ / short ~0.25Δ, 25-60 DTE, same risk budget, defined risk, no naked selling). Which one is used is learned
live per PM: results are scored in R (P&L / risk) per expression; alternate until 4 of each, then Thompson sampling.
Quotes/greeks: Alpaca options snapshots (indicative feed, your paper keys). Fills at the natural side + $0.05/contract.
Exits: PM's stop on the underlying, signal flip, 80% of max value, 7 DTE, holding-period limit. If the broker link is on,
spreads are mirrored to the Alpaca PAPER account as `mleg` orders (never to a live account from this code).
ws control: `{"type":"stockopts","on":true|false}`.

## Running 24/7 on this PC
`scripts\install_24x7.ps1` (already installed) registers the scheduled task **JB Capital Floor**: at logon it starts
`scripts\watchdog.ps1` hidden, which runs the server without a browser, restarts it if it crashes or stops answering
for 3 minutes, and logs to `logs\`. `run.bat` now just opens the game (starting the watchdog if needed);
`run.bat console` runs the old way. Remove: `Unregister-ScheduledTask -TaskName "JB Capital Floor" -Confirm:$false`.
