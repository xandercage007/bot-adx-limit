import { config } from "./config.js";
import { logger } from "./logger.js";
import { fetchOHLCV } from "./exchange.js";
import { calcSupertrend, findSwingLevels } from "./technicalAnalysis.js";
import { computeStopTakeProfit } from "./riskManager.js";

function timeframeToMs(tf) {
  const unit = tf.slice(-1);
  const n = parseInt(tf, 10);
  const map = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return n * (map[unit] || map.m);
}

function isCandleClosed(candle, timeframeMs) {
  return Date.now() >= candle[0] + timeframeMs;
}

// Holds macro-direction candidates that are waiting for short-timeframe
// (5m) confirmation before a real LIMIT entry order is placed for them.
export class EntryQueue {
  constructor() {
    this.pending = new Map(); // symbol -> { candidate, addedAt }
  }

  add(candidate) {
    if (this.pending.has(candidate.symbol)) return;
    this.pending.set(candidate.symbol, { candidate, addedAt: Date.now() });
    logger.info(
      `${candidate.symbol}: queued for ${config.entryTimeframe} entry confirmation (${candidate.direction})`,
    );
  }

  has(symbol) {
    return this.pending.has(symbol);
  }
}

// Checks whether the FAST timeframe confirms the queued direction, and if
// so, works out WHERE to place a LIMIT entry order (not a market order):
//
//   1. Supertrend (5m) must agree with the candidate's direction, AND
//   2. the last fully-CLOSED 5m candle must have closed in that direction
//      (bullish for a long, bearish for a short) — so we don't confirm on
//      a candle that's still moving against us.
//   3. The limit price itself is the 5m swing support (for a long) or
//      swing resistance (for a short) over `entry.limitLookback` candles —
//      i.e. we wait for a small pullback/bounce toward a recent 5m level
//      instead of paying the current market price.
//
// The stop-loss/take-profit computed here (via computeStopTakeProfit, which
// uses 1h structure — see riskManager.js) are only a PRELIMINARY estimate
// for position sizing and the pre-fill validity check. liveTrader.js
// recomputes the FINAL SL/TP once the limit order actually fills, since the
// real fill price can differ from this limit price if the market moves
// through it.
async function checkConfirmation(exchange, symbol, candidate) {
  const candles = await fetchOHLCV(
    exchange,
    symbol,
    config.entryTimeframe,
    config.entryCandleLimit,
  );
  if (!candles || candles.length < 40) return null;

  const tfMs = timeframeToMs(config.entryTimeframe);
  const closed = candles.filter((c) => isCandleClosed(c, tfMs));
  if (closed.length < 30) return null;

  const st = calcSupertrend(closed);
  if (!st) return null;

  const last = closed[closed.length - 1];
  const candleBullish = last[4] > last[1]; // close > open
  const direction = candidate.direction;

  const confirms =
    (direction === "long" && st.trend === "up" && candleBullish) ||
    (direction === "short" && st.trend === "down" && !candleBullish);

  if (!confirms) return null;

  const swing5m = findSwingLevels(closed, config.entry.limitLookback);
  let limitPrice = direction === "long" ? swing5m.support : swing5m.resistance;
  const currentPrice = last[4];
  const maxDistance =
    currentPrice * (config.entry.maxLimitDistancePercent / 100);

  if (direction === "long" && currentPrice - limitPrice > maxDistance) {
    limitPrice = currentPrice - maxDistance; // به‌جای سطح دور، نزدیک‌ترش کن
  } else if (direction === "short" && limitPrice - currentPrice > maxDistance) {
    limitPrice = currentPrice + maxDistance;
  }
  if (!limitPrice) return null;

  const { stopLoss, takeProfit, riskReward, isValid, reason } =
    computeStopTakeProfit(direction, limitPrice, candidate);

  if (!isValid) {
    logger.info(
      `${symbol}: confirmed on ${config.entryTimeframe} but structure risk rejected it — ${reason}`,
    );
    return null;
  }

  return { entry: limitPrice, stopLoss, takeProfit, riskReward };
}

// Runs a background poll (does not block) that checks every `pollSeconds`
// whether any queued candidate has confirmed on the fast timeframe yet.
// Confirmed candidates are handed to `onConfirmed`; candidates that never
// confirm within `maxWaitMinutes` are dropped — the macro setup may no
// longer be fresh by then, so we don't chase it.
export function startEntryTimingLoop(exchange, queue, onConfirmed) {
  const pollMs = config.entry.pollSeconds * 1000;
  logger.info(
    `Entry timing loop started — polling every ${pollMs / 1000}s on ${config.entryTimeframe}`,
  );

  setInterval(async () => {
    for (const [symbol, { candidate, addedAt }] of queue.pending.entries()) {
      const waitedMs = Date.now() - addedAt;
      if (waitedMs > config.entry.maxWaitMinutes * 60 * 1000) {
        logger.info(
          `${symbol}: entry confirmation window expired (${config.entry.maxWaitMinutes}min) — discarding.`,
        );
        queue.pending.delete(symbol);
        continue;
      }

      try {
        const confirmation = await checkConfirmation(
          exchange,
          symbol,
          candidate,
        );
        if (!confirmation) continue;

        queue.pending.delete(symbol);
        const finalCandidate = { ...candidate, ...confirmation };

        logger.trade(
          `${symbol}: ${config.entryTimeframe} entry CONFIRMED for ${candidate.direction} — ` +
            `limit=${confirmation.entry.toFixed(4)} SL=${confirmation.stopLoss.toFixed(4)} ` +
            `TP=${confirmation.takeProfit.toFixed(4)} RR=${confirmation.riskReward.toFixed(2)}`,
        );

        await onConfirmed(finalCandidate);
      } catch (err) {
        logger.warn(`Entry timing check failed for ${symbol}:`, err.message);
      }
    }
  }, pollMs);
}
