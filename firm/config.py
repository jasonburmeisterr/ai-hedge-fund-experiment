"""Settings for JB Capital's AI trading floor. Change numbers here, not in the agent code."""
import os

# Secrets (broker keys) live in ai-trading-floor/.env, which git ignores. Format: KEY=value, one per line.
_ENV = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
if os.path.exists(_ENV):
    for _line in open(_ENV, encoding="utf-8"):
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

STARTING_CASH = 100_000.0
FUND_NAME = "JB Capital AI Multi-Strategy Fund"
LOOP_SECONDS = 60          # how often the floor wakes up
YAHOO_EVERY = 2            # Yahoo is polled every N loops (it rate-limits)
BAR_MINUTES = 15           # signals are made on completed 15-minute bars
BAR = f"{BAR_MINUTES}m"

# Each instrument the firm watches.
#   cls: crypto | etf | stock | futures      intraday: also streamed on 15-minute bars (the original desk)
#   pv: $ per 1.0 price move per unit (futures point value)    step: smallest tradable quantity
#   fee_pct / fee_per: commission as % of notional, or $ per contract per side    slip_pct: spread + slippage per fill
#
# REALISTIC COSTS (what you'd actually pay live, small account):
#   crypto  - Kraken Pro / Coinbase Advanced with LIMIT orders: ~0.25% maker fee + ~0.10% slippage/missed fills, per side
#   ETFs    - Alpaca / IBKR: $0 commission, ~0.03-0.10% spread + slippage depending on liquidity
#   futures - IBKR micro contracts: ~$1.00 per contract per side all-in, ~1 tick slippage
CRYPTO = dict(fee_pct=0.0025, slip_pct=0.0010)
def etf(sym, name, slip=0.0004):
    return dict(sym=sym, name=name, cls="etf", src="yahoo", id=sym, pv=1, step=1, fee_pct=0.0, slip_pct=slip, shorts=False, intraday=False)
INSTRUMENTS = [
    dict(sym="BTC", name="Bitcoin", cls="crypto", src="coinbase", id="BTC-USD", pv=1, step=0.0001, shorts=False, intraday=True, **CRYPTO),
    dict(sym="ETH", name="Ethereum", cls="crypto", src="coinbase", id="ETH-USD", pv=1, step=0.001, shorts=False, intraday=True, **CRYPTO),
    dict(sym="SOL", name="Solana", cls="crypto", src="coinbase", id="SOL-USD", pv=1, step=0.01, shorts=False, intraday=True, fee_pct=0.0025, slip_pct=0.0015),
    dict(sym="SPY", name="S&P 500 ETF", cls="etf", src="yahoo", id="SPY", pv=1, step=1, fee_pct=0.0, slip_pct=0.0002, shorts=False, intraday=True),
    dict(sym="NVDA", name="Nvidia", cls="stock", src="yahoo", id="NVDA", pv=1, step=1, fee_pct=0.0, slip_pct=0.0004, shorts=False, intraday=True),
    dict(sym="MNQ", name="Micro Nasdaq fut", cls="futures", src="yahoo", id="NQ=F", pv=2, step=1, fee_per=1.0, slip_pct=0.0001, shorts=True, intraday=True),
    dict(sym="MGC", name="Micro Gold fut", cls="futures", src="yahoo", id="GC=F", pv=10, step=1, fee_per=1.0, slip_pct=0.0001, shorts=True, intraday=True),
    # daily-only universe: liquid ETFs across asset classes (all tradeable on Alpaca)
    etf("QQQ", "Nasdaq-100 ETF", 0.0002), etf("IWM", "Small caps ETF", 0.0003), etf("EFA", "Developed intl ETF"), etf("EEM", "Emerging mkts ETF"),
    etf("TLT", "20y Treasuries ETF", 0.0003), etf("IEF", "7-10y Treasuries ETF", 0.0003), etf("HYG", "High-yield bonds ETF"),
    etf("GLD", "Gold ETF", 0.0003), etf("SLV", "Silver ETF", 0.0005), etf("USO", "Oil ETF", 0.0006), etf("DBC", "Commodities ETF", 0.0008),
    etf("XLE", "Energy sector ETF"), etf("XLK", "Tech sector ETF"), etf("XLF", "Financials ETF"), etf("VNQ", "Real estate ETF", 0.0005),
]
INST = {i["sym"]: i for i in INSTRUMENTS}
DAILY_UNIVERSE = [i["sym"] for i in INSTRUMENTS]             # everything trades on daily bars
INTRADAY = [i for i in INSTRUMENTS if i.get("intraday")]     # the original 15-minute desk
DAILY_REFRESH_MIN = 20                                       # how often daily bars are refreshed

# Risk rules (Rex, the CRO, enforces these)
RISK_PER_TRADE = 0.02      # STARTING risk per trade, as a share of the pod's capital (pod capital = NAV x allocation),
                           # for pods without evidence yet; the CIO's risk dial (toolbox.py) takes over once it has run
MIN_POD_RISK = 0.0025      # the CIO's risk dial per pod stays between these two
MAX_POD_RISK = 0.10
RISK_APPETITE = 0.5        # the CIO bets this fraction of Kelly (0.25 cautious ... 1.0 full Kelly); ruin tolerance = 20% x this
MAX_TOTAL_RISK = 0.05      # all open stops across the fund: at most 5% of NAV
MAX_POS_NOTIONAL = 0.25    # crypto/stock position: at most 25% of NAV
MAX_FUT_LEVERAGE = 3.0     # futures exposure: at most 3x NAV in total
MAX_GROSS = 1.0            # stocks/ETFs/crypto held: at most this multiple of NAV. 1.0 = cash only; up to 2.0 = margin
MARGIN_RATE = 0.065        # yearly interest on borrowed cash (approximate broker margin rate: check your broker's current rate)
# Rex's risk book: limits on the WHOLE fund, all pods together (each pod only sees its own book; see riskbook.py)
MAX_SYM_NOTIONAL = 0.25    # one market, same direction, all pods: at most 25% of NAV
MAX_GROUP_NOTIONAL = 0.50  # one group of look-alike markets (below), same direction, all pods: at most 50% of NAV
RISK_GROUPS = {
    "US stocks": ["SPY", "QQQ", "IWM", "NVDA", "MNQ", "XLK", "XLF", "VNQ"],
    "Intl stocks": ["EFA", "EEM"],
    "Bonds": ["TLT", "IEF", "HYG"],
    "Metals": ["GLD", "SLV", "MGC"],
    "Energy & commodities": ["USO", "DBC", "XLE"],
    "Crypto": ["BTC", "ETH", "SOL"],
}
SYM_GROUP = {s: g for g, ss in RISK_GROUPS.items() for s in ss}
MAX_POSITIONS = 8
POD_DD_LIMIT = 0.08        # a pod down 8% of its capital from its peak P&L gets shut down (pod-shop rule)
MIN_ALLOC, MAX_ALLOC = 0.05, 0.45   # CIO allocation bounds per active pod
STOP_ATR = 2.0             # initial stop = 2 x ATR
TRAIL_ATR = 3.0            # trailing stop = 3 x ATR from the best price
TIME_STOP_BARS = 96        # close anything older than 24h of 15m bars

# Team huddle: everyone meets at the holo table
HUDDLE_EVERY_MIN = int(os.environ.get("FLOOR_HUDDLE_MIN", "45"))

# Investor letters (written by the CIO with Claude)
LETTER_EVERY_H = 24

# Sam: how a call gets graded
SCORE_HORIZON_BARS = 4     # judge each call 1 hour (4 bars) later
MIN_CALLS_FOR_TRUST = 10   # trust stays at 1.0 until an agent has this many graded calls

# Ava (AI analyst + researcher).
#   claude-code (default): uses the Claude Code CLI with your Claude Max plan, no API key needed
#   claude: Anthropic API with ANTHROPIC_API_KEY (pay-as-you-go) · off: Ava stays home
LLM = os.environ.get("FLOOR_LLM", "claude-code").lower()
LLM_MODEL = os.environ.get("FLOOR_MODEL", "claude-opus-5-5")
ANALYST_EVERY_MIN = int(os.environ.get("FLOOR_ANALYST_MIN", "60"))

# R&D lab
RESEARCH_EVERY_MIN = int(os.environ.get("FLOOR_RESEARCH_MIN", "60"))
FIRST_RESEARCH_SEC = 90        # first research session shortly after startup
IDEAS_PER_SESSION = 2
MAX_HIRES = 3                  # desks available for new quants
FIRE_AFTER_CALLS = 15          # a hire is judged live after this many graded calls...
FIRE_BELOW_TRUST = 0.6         # ...and fired if trust is below this
BENCH_FOUNDER_AFTER = 25       # Mo/Rita get auto-benched if trust < 0.5 after this many calls


STATE_FILE = os.environ.get("FLOOR_STATE") or os.path.join(os.path.dirname(os.path.dirname(__file__)), "state.json")

SCORE_HORIZON_DAYS = 5           # daily-bar PMs: a call is graded 5 trading days later

# Alpaca broker mirror (paper by default). Keys go in .env, see .env.example
ALPACA_KEY = os.environ.get("ALPACA_KEY", "")
ALPACA_SECRET = os.environ.get("ALPACA_SECRET", "")
ALPACA_LIVE = os.environ.get("ALPACA_LIVE", "0") == "1"      # REAL money only if you set this on purpose
ALPACA_SYNC_SEC = 180                # reconcile with the broker every 3 minutes
ALPACA_MAX_ORDER = 0.60              # sanity cap: no single order over 60% of the account (catches unit/scale bugs)
ALPACA_DAILY_LOSS_KILL = 0.03        # broker account down 3% on the day -> flatten everything and stop

# JB Ventures (the venture studio tower)
STUDIO_EVERY_MIN = int(os.environ.get("FLOOR_STUDIO_MIN", "120"))   # one studio session every 2 hours
STUDIO_FIRST_SEC = 240                                               # first session ~4 minutes after startup
STUDIO_IDEAS = 2
NEWS_FETCH_MIN = int(os.environ.get("FLOOR_NEWS_FETCH_MIN", "10"))     # reporters check the RSS feeds every 10 minutes
NEWS_BRIEF_MIN = int(os.environ.get("FLOOR_NEWS_BRIEF_MIN", "60"))     # Nia's briefing every hour
NEWS_FIRST_BRIEF_SEC = 150
NEWS_FAST_SEC = 60                                                      # Benzinga (via Alpaca) checked every minute
CAREER_SCOUT_H = int(os.environ.get("FLOOR_CAREER_SCOUT_H", "24"))     # Maya scouts new programs once a day                                              # first briefing ~2.5 minutes after startup                                                     # ideas per session
