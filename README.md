# Binance Structure-Based Futures Bot (Demo Trading)

Three-layer pipeline:

1. **Macro filters (1h + 4h)** decide *direction only*.
2. **Fast confirmation + limit pricing (5m)** decides *when* to enter and
   places a **LIMIT** order at a 5m swing support/resistance level — not a
   market order.
3. **Market-structure risk management** (`src/structureRiskManager.js`)
   computes SL/TP from 1h swing highs/lows + ATR once the limit order
   actually fills, replacing fixed ATR-multiple/percentage exits entirely.
   A strict Risk:Reward filter rejects trades outright if the structure
   doesn't support a realistic setup.

On top of that, every open position is watched for a **breakeven** trigger
and a **time-based exit**, and every closed trade (win or loss) is logged to
a JSON file with a running win-rate.

## How a trade happens

1. **Every 15 min** (`scanIntervalMinutes`): scan the top-volume USDT
   perpetuals on the **1h** timeframe. A symbol becomes a directional
   candidate if EMA20/50 + RSI agree on a direction, ADX ≥ 15, volume is at
   or above average, and the 4h trend doesn't directly conflict. The 1h
   candles, ATR, and ADX are attached to the candidate for later use.

2. **Queued for entry confirmation.** The candidate waits (up to
   `entry.maxWaitMinutes`) for the **5m** timeframe to confirm:
   - **Supertrend** flips to match the candidate's direction, AND
   - the last fully-closed 5m candle actually closed in that direction.

   On confirmation, the **limit entry price** is set to the 5m swing
   support (long) or resistance (short) over `entry.limitLookback` candles
   — buying a small pullback / selling a small bounce, instead of paying
   the current market price.

3. **Structure-based SL/TP is computed** (`computeStopTakeProfit` →
   `structureRiskManager.computeStructureRisk`) using this limit price as a
   preliminary anchor:
   - **Stop-loss:** 1h swing low/high (over `structure.slLookback` candles)
     minus/plus `structure.slAtrBuffer` × ATR — placed just beyond the
     level so ordinary noise/liquidity-sweep wicks don't trigger it.
   - **Take-profit:** `structure.tpFractionTrending` (85%) of the distance
     to the next 1h swing high/low (over `structure.tpLookback` candles) —
     never on or past the level itself. Drops to `tpFractionChoppy` (70%)
     when ADX is below `structure.adxTrendThreshold` (sideways market).
   - **Reject entirely** if the resulting Risk:Reward falls outside
     `[structure.minRR, structure.maxRR]` (default 1.1–3.0).

4. **LIMIT order placed** at that price. `src/limitEntryManager.js` polls
   every `entry.limitPollSeconds` for a fill, and cancels the order if it
   never fills within `entry.limitFillTimeoutMinutes`.

5. **On fill**, `liveTrader.finalizeEntry` recomputes the FINAL SL/TP off
   the real fill price (not the limit price estimate) and places real
   reduce-only `STOP_MARKET` / `TAKE_PROFIT_MARKET` orders — so they still
   fire even if the bot process dies.

## Position management guardrails (every 1 minute)

`src/trendMonitor.js` (`startPositionMonitor`) checks three things per open
position, in order:

- **Time-based exit:** if held more than `risk.management.maxHoldCandles`
  1h candles without hitting TP or breakeven, close at market — avoids
  holding through trend decay.
- **Breakeven:** once price has moved `risk.management.breakevenAtrTrigger`
  × ATR in profit, the stop is moved to entry + a small fee buffer
  (`risk.management.feeBufferPercent`).
- **Confirmed 1h trend reversal** (independent, slower safety net): closes
  the position if the 1h trend has genuinely flipped against it — 2
  consecutive closed candles plus ADX still elevated, so it isn't reacting
  to noise.

## Orphan SL/TP cleanup + trade logging

Since STOP_MARKET and TAKE_PROFIT_MARKET are separate reduce-only orders
(no native OCO on Binance futures), `src/orderCleanup.js` runs every 30s,
checking only symbols this bot has traded. When it finds a symbol whose
position closed but one of its two known orders is still open, it:

1. Fetches the order that's now missing (the one that filled) to get the
   real exit price and determine win/loss.
2. Logs the result via `src/tradeHistory.js` to `data/live-trade-log.json`.
3. Cancels the remaining orphan order.

Manual/monitor-triggered closes (`liveTrader.closePosition`, used by the
time-exit and trend-reversal checks) log their own result directly at
close time instead.

Run `npm run winrate` anytime to print a summary:

```
=== Win Rate Report ===
Total trades: 42
Wins:         27
Losses:       15
Win rate:     64.3%
Total PnL:    118.42 USDT
```

## Why this design

- **Structure over fixed targets:** a fixed ATR-multiple or flat % target
  ignores where the market actually is. Anchoring SL just beyond a real
  swing level (with a buffer against noise) and TP just before the next one
  reflects where price is statistically more/less likely to reverse.
- **Limit entry at a 5m level, not market:** entering into a small pullback
  toward 5m support/resistance instead of chasing price is what actually
  addresses "opens and immediately goes into drawdown" — no order type
  changes that; what changes is WHERE you enter.
- **Strict RR filter rejects bad structure outright** — if the swing levels
  imply an unrealistic reward relative to risk, the trade is skipped, not
  forced through with a degenerate target.
- **Breakeven + time exit** protect against a trade that stalls — locking
  in no-loss once it's proven itself, and cutting it loose if it goes
  nowhere for too long.

## Position sizing

Every trade uses a **fixed dollar margin** — `risk.fixedMarginPerTradeUSDT`
(default $20) — regardless of balance. Set it to `null` to fall back to
percentage-based sizing (`riskPerTradePercent` + `maxMarginPercentPerTrade`).
Leverage (`exchange.defaultLeverage`) affects only how much notional that
margin buys — never the SL/TP levels.

## Setup

```bash
cd binance-bot
npm install
cp .env.example .env
```

Put **Binance Demo Trading API keys** in `.env` (generated from Binance's
Demo Trading UI, not your regular account keys):

```
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
```

```bash
npm start
```

## Read this before it runs unattended

- **I could not test this against Binance's live API** (no internet access
  in the sandbox where this was written). Syntax is checked, and the
  structure-risk math was verified with a standalone smoke test against
  mocked candle data — but watch the first few cycles closely on the
  Binance UI to confirm entry/SL/TP orders appear exactly as expected.
- **No indicator, entry-timing, or exit-management scheme guarantees a win
  rate.** This fixes specific, real problems (stale-price SL/TP, market-order
  chasing, fixed targets ignoring structure) — it doesn't make the strategy
  profitable by itself. Only real forward-testing on your demo account,
  and `npm run winrate`, will show you that.
- **If a STOP_MARKET or TAKE_PROFIT_MARKET order fails to place**, the bot
  logs an `[ERROR]` saying the position is open with no exchange-side
  protection — check it manually if you see that line.
- Leverage amplifies losses as much as gains. Not financial advice.

## Tuning

All knobs live in `src/config.js`: `risk.structure.*` (SL/TP lookbacks,
ATR buffer, RR bounds, TP fractions, ADX threshold), `risk.management.*`
(breakeven/time-exit), entry timeframe/limit lookback/timeouts, ADX/volume
thresholds, fixed margin per trade, leverage, max open positions, scan
interval, universe size.

## File overview

| File | Purpose |
|---|---|
| `src/config.js` | All tunable settings |
| `src/exchange.js` | ccxt/Binance connection, demo trading toggle, market/position data |
| `src/technicalAnalysis.js` | ATR/RSI/EMA/ADX/Supertrend + 1h macro direction assessment |
| `src/scanner.js` | Macro (1h+4h) filter chain → directional candidates + raw 1h candles/ATR/ADX |
| `src/entryTiming.js` | Queues candidates, confirms on 5m Supertrend + candle close, prices the limit entry off 5m support/resistance |
| `src/structureRiskManager.js` | `computeStructureRisk` (swing-based SL/TP + RR filter) and `monitorPosition` (breakeven + time exit) — pure functions |
| `src/riskManager.js` | Wraps `computeStructureRisk` with this project's config + position sizing + basic eligibility checks |
| `src/limitEntryManager.js` | Tracks placed limit entry orders, polls for fill/timeout |
| `src/paperTrader.js` | Local-only simulated account (used when `mode: "paper"`) |
| `src/liveTrader.js` | Places the limit entry, finalizes SL/TP on fill, updates SL for breakeven, closes positions + logs results |
| `src/trendMonitor.js` | 1-minute position monitor: breakeven, time exit, confirmed 1h trend reversal |
| `src/orderCleanup.js` | 30-second orphaned SL/TP cleanup + natural-fill trade logging |
| `src/positionRegistry.js` | In-memory record of each open position's entry/ATR/order ids/open time |
| `src/tradeHistory.js` | Persists closed trades to JSON, computes win rate |
| `src/winrateReport.js` | `npm run winrate` — prints the win-rate summary |
| `src/index.js` | Wires the scan cycle, entry queue, limit-entry monitor, position monitor, and order cleanup together |
