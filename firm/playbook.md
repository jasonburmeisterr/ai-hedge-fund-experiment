# JB Capital research playbook (Ava reads this before every research session)

## Documented effects worth testing (ideas, not guarantees)
- **Time-series momentum** (Moskowitz, Ooi & Pedersen 2012): an asset's own past return predicts its
  near-future return in futures across asset classes. Strongest at weeks-to-months horizons; on 15-minute
  bars it is much noisier. Family: tsmom (lookback ~96-288 bars = 1-3 days).
- **Breakouts / trend-following** (CTA style): new highs in an uptrend tend to keep going. Works in trending
  regimes, bleeds in choppy ones. Family: breakout. A volatility filter often matters.
- **Short-term reversal**: very short-horizon extremes tend to partly revert (liquidity effect). Usually
  stronger in calm markets and weaker or reversed in strong trends. Family: meanrev; consider with_trend
  (only buy dips in uptrends) and a low-vol filter.
- **Volatility clustering / vol-managed exposure** (Moreira & Muir 2017): high volatility predicts high
  volatility but not higher returns, so cutting exposure in high-vol regimes improves risk-adjusted results.
  Use vol_min / vol_max (ATR rank over the last 100 bars).
- **Crypto**: trades 24/7, strong momentum bursts, frequent fakeouts, wider costs (0.1% fee + slippage per side).
- **Index/gold futures and stocks**: Yahoo data, regular trading sessions, overnight gaps.

## Hard rules (how we avoid fooling ourselves)
1. Costs are real: fees + slippage are charged on every trade. Fast strategies need a big edge per trade.
2. The backtest uses ~60 days (stocks/futures) or ~90 days (crypto) of 15-minute bars. The last 40% is
   out-of-sample. An idea is only hired if it works out-of-sample (PF >= 1.15, >= 15 trades, positive)
   AND does not lose in-sample.
3. Don't tweak a failed idea by tiny parameter changes hoping it passes; that is curve-fitting.
   Change the IDEA (a different family, regime filter or market set) and say why.
4. Prefer simple ideas with a clear economic reason. Say how you expect the idea to fail.
5. Most ideas fail. That is normal and useful information.
