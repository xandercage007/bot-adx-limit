import { config } from "./config.js";
import { logger } from "./logger.js";
import { fetchOpenPositions, fetchOHLCV } from "./exchange.js";
import { calcEMA, calcADX } from "./technicalAnalysis.js";
import { monitorPosition } from "./structureRiskManager.js";
import { getPositionDetails } from "./positionRegistry.js";

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const CONFIRMATION_CANDLES = 2; // 1h trend must hold across this many consecutive CLOSED candles

function timeframeToMs(tf) {
  const unit = tf.slice(-1);
  const n = parseInt(tf, 10);
  const map = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return n * (map[unit] || map.h);
}

function isCandleClosed(candle, timeframeMs) {
  return Date.now() >= candle[0] + timeframeMs;
}

// Recompute EMA20/50 trend using only fully-closed candles, and require the
// SAME trend on each of the last CONFIRMATION_CANDLES closed candles in a
// row — a single flip is treated as noise, not a confirmed reversal.
function getConfirmedTrend(candles, timeframe) {
  const tfMs = timeframeToMs(timeframe);
  const closed = candles.filter((c) => isCandleClosed(c, tfMs));
  if (closed.length < 60) return { trend: "unknown", adx: null };

  const trends = [];
  for (let i = CONFIRMATION_CANDLES - 1; i >= 0; i--) {
    const slice = closed.slice(0, closed.length - i);
    const ema20 = calcEMA(slice, 20);
    const ema50 = calcEMA(slice, 50);
    if (!ema20 || !ema50) return { trend: "unknown", adx: null };
    trends.push(ema20 > ema50 ? "up" : ema20 < ema50 ? "down" : "flat");
  }

  const allSame = trends.every((t) => t === trends[0]);
  const adx = calcADX(closed);

  return { trend: allSame ? trends[0] : "mixed", adx };
}

function positionDirection(position) {
  if (position.side === "long") return "long";
  if (position.side === "short") return "short";
  return null;
}

function positionAmount(position) {
  const raw = position.contracts ?? position.info?.positionAmt ?? 0;
  return Math.abs(Number(raw));
}

// Runs every minute against every open position and checks THREE
// independent exit conditions, in order:
//
//   1. Time-based exit (structureRiskManager.monitorPosition) — held more
//      than `risk.management.maxHoldCandles` 1h candles without hitting
//      TP or breakeven.
//   2. Breakeven (structureRiskManager.monitorPosition) — price has moved
//      `risk.management.breakevenAtrTrigger` × ATR in profit, so the stop
//      gets moved to entry + a small fee buffer.
//   3. Confirmed 1h trend reversal — a slower, independent safety net for
//      positions that neither hit their target nor got held long enough
//      to trigger the time exit, but where the bigger picture has
//      genuinely turned against the trade (2 consecutive closed candles +
//      ADX still elevated).
//
// (1) and (3) close the position via `trader.closePosition`; (2) updates
// the stop via `trader.updateStopLoss`. Both require the position details
// registered in positionRegistry.js (entry price, ATR, open time) — a
// position the bot doesn't have details for (e.g. opened before a restart)
// is skipped for (1)/(2) but still covered by (3).
export function startPositionMonitor(exchange, trader) {
  logger.info(`Position monitor started — checking every ${CHECK_INTERVAL_MS / 1000}s`);

  const intervalId = setInterval(async () => {
    try {
      const positions = await fetchOpenPositions(exchange);
      if (positions.length === 0) return;

      for (const pos of positions) {
        const direction = positionDirection(pos);
        if (!direction) continue;

        const amount = positionAmount(pos);
        if (amount <= 0) continue;

        const details = getPositionDetails(pos.symbol);

        // --- Breakeven + time-based exit (needs registry details) ---
        if (details) {
          const currentPrice = Number(pos.markPrice ?? pos.info?.markPrice ?? pos.entryPrice);
          const result = monitorPosition(
            { side: direction, entry: details.entry, openedAt: details.openedAt, breakevenSet: details.breakevenSet },
            currentPrice,
            details.atr,
            {
              breakevenAtrTrigger: config.risk.management.breakevenAtrTrigger,
              feeBufferPercent: config.risk.management.feeBufferPercent,
              maxHoldCandles: config.risk.management.maxHoldCandles,
              candleTimeframeMs: timeframeToMs(config.timeframe),
            }
          );

          if (result.action === "CLOSE_MARKET") {
            logger.trade(`${pos.symbol}: ${result.reason} — closing at market.`);
            const side = direction === "long" ? "buy" : "sell";
            await trader.closePosition(pos.symbol, side, amount);
            continue; // position is gone — skip the trend-reversal check below
          }

          if (result.action === "UPDATE_SL") {
            logger.info(`${pos.symbol}: ${result.reason}`);
            await trader.updateStopLoss(pos.symbol, result.newSL);
          }
        }

        // --- Confirmed 1h trend reversal (independent of registry details) ---
        let candles;
        try {
          candles = await fetchOHLCV(exchange, pos.symbol, config.timeframe, config.candleLimit);
        } catch (err) {
          logger.warn(`Trend monitor: could not fetch candles for ${pos.symbol}:`, err.message);
          continue;
        }

        const { trend, adx } = getConfirmedTrend(candles, config.timeframe);
        if (trend === "unknown" || trend === "mixed") continue;

        const reversed =
          (direction === "long" && trend === "down") || (direction === "short" && trend === "up");
        if (!reversed) continue;

        if (adx == null || adx < config.risk.minADX) {
          logger.info(
            `${pos.symbol}: EMA trend flipped against ${direction} position, but ADX ` +
              `${adx?.toFixed?.(1) ?? "n/a"} is below ${config.risk.minADX} — not confident yet, holding.`
          );
          continue;
        }

        logger.trade(
          `TREND REVERSAL CONFIRMED on ${pos.symbol}: ${direction} position, ${config.timeframe} trend ` +
            `flipped to ${trend} and held for ${CONFIRMATION_CANDLES} closed candles (ADX=${adx.toFixed(1)}). Closing now.`
        );

        const side = direction === "long" ? "buy" : "sell";
        await trader.closePosition(pos.symbol, side, amount);
      }
    } catch (err) {
      logger.error("Position monitor cycle failed:", err.message);
    }
  }, CHECK_INTERVAL_MS);

  return intervalId;
}
