# Binance Structure-Based Futures Bot (Demo Trading)

Three-layer pipeline:

1. **Macro filters (1h + 4h)** decide *direction only*.
2. **Fast confirmation + limit pricing (5m)** decides *when* to enter and
   places a **LIMIT** order at a 5m swing support/resistance level.
3. **Market-structure risk & position management**
   (`src/structureRiskManager.js`) computes SL/TP from 1h swing highs/lows +
   ATR, and governs every exit after that — breakeven, time-based, and a
   trend-reversal check that is **structurally incapable of closing a
   losing trade**.

## No panic-selling — how it's actually enforced

The single most important rule in this bot: **a losing trade can only be
closed by its hard stop-loss.** This isn't just a comment or a convention —
it's enforced by the shape of the code:

- `checkProfitGatedReversal` (the only function that can trigger an
  indicator-based early exit) checks `profitDistance < profitAtrTrigger × ATR`
  as its very first line and returns `shouldExit: false` immediately if
  that fails — the EMA20/RSI conditions below it are unreachable code paths
  for a flat-or-losing trade. There's no scenario where it evaluates RSI or
  EMA before knowing the trade is in meaningful profit.
- The only exit path that CAN fire while at a loss is the **time-based
  exit** (`monitorPosition`'s `CLOSE_MARKET`) — an unconditional guard
  against a trade dragging on for 6+ candles, deliberately not an
  "indicator" or "trend reversal" signal.
- Breakeven (`UPDATE_SL`) only ever moves the stop in the trade's favor —
  it cannot close a position.

## How a trade happens

1. **Every 15 min**: scan 1h — EMA20/50 + RSI direction, ADX ≥ 15, volume
   ≥ average, 4h trend not conflicting. 1h candles/ATR/ADX attach to the
   candidate.
2. **5m confirmation**: Supertrend + closed-candle direction agree → limit
   entry price = 5m swing support (long) / resistance (short).
3. **Structure-based SL/TP** (`computeStructureRisk`):
   - **SL:** 1h swing low/high (`structure.slLookback`, 15-20 candles)
     ∓ `structure.slAtrBuffer` (0.5) × ATR.
   - **TP:** `structure.tpFractionTrending` (85%, or 70% if ADX <
     `structure.adxTrendThreshold`) of the distance to the next 1h swing
     high/low (`structure.tpLookback`, 20-30 candles) — never at or past it.
   - **Reject outright** if `RR < structure.minRR` (1.2). No upper cap by
     default (`structure.maxRR: null`).
4. **LIMIT order placed**; polled for fill (`limitEntryManager.js`),
   cancelled if it never fills within `entry.limitFillTimeoutMinutes`.
5. **On fill**: final SL/TP recomputed off the real fill price, real
   reduce-only `STOP_MARKET`/`TAKE_PROFIT_MARKET` orders placed.

## Position management (every 1 minute, in this order)

1. **Time-based exit (unconditional):** held more than
   `management.maxHoldCandles` (6) 1h candles without hitting TP or
   breakeven → close at market, win or lose.
2. **Smart breakeven (noise-resistant):** triggers when EITHER holds:
   - profit ≥ `management.breakevenAtrTrigger` (1.2) × ATR, OR
   - profit ≥ 50% of the distance to TP.
   New SL = `entry ± management.breakevenSLBufferAtr` (0.15) × ATR — never
   exactly at entry, so ordinary noise and fees can't immediately tag it.
3. **Profit-gated trend-reversal exit (the only indicator-based exit):**
   only even evaluated if profit ≥ `management.reversalProfitAtrTrigger`
   (0.5) × ATR, and then:
   - Long: exit if `currentPrice > entry` AND last closed 1h candle's
     close < EMA20 AND RSI < `management.reversalRsiLongExitMax` (45).
   - Short: exit if `currentPrice < entry` AND close > EMA20 AND RSI >
     `management.reversalRsiShortExitMin` (55).

## Orphan SL/TP cleanup + trade logging

`src/orderCleanup.js` (every 30s) detects which of a closed position's two
reduce-only orders actually filled, logs the result (`src/tradeHistory.js`
→ `data/live-trade-log.json`), and cancels the leftover one. Monitor-
triggered closes (time exit, reversal exit) log their result directly at
close time instead. Run `npm run winrate` anytime for a summary:

```
=== Win Rate Report ===
Total trades: 42
Wins:         27
Losses:       15
Win rate:     64.3%
Total PnL:    118.42 USDT
```

## Position sizing

Fixed dollar margin per trade — `risk.fixedMarginPerTradeUSDT` (default
$20) — regardless of balance. Set to `null` for percentage-based sizing
(`riskPerTradePercent` + `maxMarginPercentPerTrade`). Leverage
(`exchange.defaultLeverage`) affects only notional exposure, never SL/TP.

## Setup

```bash
cd binance-bot
npm install
cp .env.example .env
```

Put **Binance Demo Trading API keys** in `.env` (from Binance's Demo
Trading UI, not your regular account keys), then:

```bash
npm start
```

## Read this before it runs unattended

- **I could not test this against Binance's live API** (no internet access
  in this sandbox). Syntax is checked, and all of `structureRiskManager.js`
  — including the new breakeven/reversal/RR-filter logic — was verified
  with a standalone smoke test against mocked positions and candles
  (covering: breakeven via both trigger paths, time-exit firing at a loss,
  and the reversal check confirmed `false` at a loss / `true` only when
  every profit+EMA+RSI condition holds). It has NOT been tested against
  real market data or a live exchange connection.
- **No exit-management scheme guarantees a win rate.** This fixes specific,
  real problems (panic-selling losers, breakeven noise, unrealistic
  targets) — it doesn't make the strategy profitable by itself. Use
  `npm run winrate` on real demo results to judge that.
- **If a STOP_MARKET/TAKE_PROFIT_MARKET order fails to place**, the bot
  logs an `[ERROR]` — check the position manually if you see that line.
- Leverage amplifies losses as much as gains. Not financial advice.

## Tuning

All knobs live in `src/config.js`: `risk.structure.*` (SL/TP lookbacks,
ATR buffer, RR floor, TP fractions, ADX threshold), `risk.management.*`
(breakeven, reversal, time-exit), entry timing/limit-order settings,
ADX/volume filters, position sizing, leverage, scan interval, universe size.

## File overview

| File | Purpose |
|---|---|
| `src/config.js` | All tunable settings |
| `src/exchange.js` | ccxt/Binance connection, demo trading toggle, market/position data |
| `src/technicalAnalysis.js` | ATR/RSI/EMA/ADX/Supertrend + 1h macro direction assessment |
| `src/scanner.js` | Macro (1h+4h) filter chain → directional candidates + raw 1h candles/ATR/ADX |
| `src/entryTiming.js` | Queues candidates, confirms on 5m Supertrend + candle close, prices the limit entry off 5m support/resistance |
| `src/structureRiskManager.js` | `computeStructureRisk` (SL/TP + RR filter), `monitorPosition` (time exit + smart breakeven), `checkProfitGatedReversal` (the only early-exit-on-indicator path — cannot fire at a loss) |
| `src/riskManager.js` | Wraps `computeStructureRisk` with this project's config + position sizing + basic eligibility checks |
| `src/limitEntryManager.js` | Tracks placed limit entry orders, polls for fill/timeout |
| `src/paperTrader.js` | Local-only simulated account (used when `mode: "paper"`) |
| `src/liveTrader.js` | Places the limit entry, finalizes SL/TP on fill, updates SL for breakeven, closes positions + logs results |
| `src/trendMonitor.js` | 1-minute position monitor: time exit → breakeven → profit-gated reversal, in that order |
| `src/orderCleanup.js` | 30-second orphaned SL/TP cleanup + natural-fill trade logging |
| `src/positionRegistry.js` | In-memory record of each open position's entry/TP/ATR/order ids/open time |
| `src/tradeHistory.js` | Persists closed trades to JSON, computes win rate |
| `src/winrateReport.js` | `npm run winrate` — prints the win-rate summary |
| `src/index.js` | Wires the scan cycle, entry queue, limit-entry monitor, position monitor, and order cleanup together |
