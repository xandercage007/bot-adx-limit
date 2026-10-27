import { config } from "./config.js";
import { logger } from "./logger.js";
import { fetchOpenPositions, fetchOHLCV } from "./exchange.js";
import { calcEMA, calcRSI } from "./technicalAnalysis.js";
import {
  monitorPosition,
  checkProfitGatedReversal,
} from "./structureRiskManager.js";
import { getPositionDetails } from "./positionRegistry.js";
import { Position } from "./models/Position.model.js";

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

function timeframeToMs(tf) {
  const unit = tf.slice(-1);
  const n = parseInt(tf, 10);
  const map = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return n * (map[unit] || map.h);
}

function isCandleClosed(candle, timeframeMs) {
  return Date.now() >= candle[0] + timeframeMs;
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

// Runs every minute against every open position. Only positions this bot
// has full details for (positionRegistry.js — entry, ATR, TP, open time)
// are evaluated; a position the bot has no record of (e.g. opened before a
// restart) is left alone entirely, since none of these checks can safely
// run without knowing its real entry/ATR/TP.
//
// Exit priority, in order:
//   1. Time-based exit — UNCONDITIONAL. Can fire even at a loss; this is a
//      structural "don't let this drag on" guard, not a reaction to
//      indicators, so rule "never panic-sell a loser" doesn't apply to it.
//   2. Breakeven — only ever tightens the stop in the trade's favor, never
//      closes anything.
//   3. Profit-gated trend-reversal exit — the ONLY early-exit-on-indicator
//      path. It is structurally incapable of firing while the trade is at
//      a loss (see structureRiskManager.js `checkProfitGatedReversal`): a
//      losing trade can ONLY be closed by the hard stop-loss already
//      resting on the exchange.
export function startPositionMonitor(exchange, trader) {
  logger.info(
    `Position monitor started — checking every ${CHECK_INTERVAL_MS / 1000}s`,
  );

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
        if (!details) continue; // no record of this position — leave it alone

        const currentPrice = Number(
          pos.markPrice ?? pos.info?.markPrice ?? pos.entryPrice,
        );
        //Save position in db
        // const positionData = Position.findOneAndUpdate()
        logger.info(details);
        //end of save position in db
        // --- 1 & 2: time exit + breakeven ---
        const mgmt = config.risk.management;
        const result = monitorPosition(
          {
            side: direction,
            entry: details.entry,
            tp: details.tp,
            openedAt: details.openedAt,
            breakevenSet: details.breakevenSet,
          },
          currentPrice,
          details.atr,
          {
            breakevenAtrTrigger: mgmt.breakevenAtrTrigger,
            breakevenSLBufferAtr: mgmt.breakevenSLBufferAtr,
            maxHoldCandles: mgmt.maxHoldCandles,
            candleTimeframeMs: timeframeToMs(config.timeframe),
          },
        );

        if (result.action === "CLOSE_MARKET") {
          logger.trade(`${pos.symbol}: ${result.reason} — closing at market.`);
          const side = direction === "long" ? "buy" : "sell";
          await trader.closePosition(pos.symbol, side, amount);
          continue; // position is gone — nothing left to check
        }

        if (result.action === "UPDATE_SL") {
          logger.info(`${pos.symbol}: ${result.reason}`);
          await trader.updateStopLoss(pos.symbol, result.newSL);
        }

        // --- 3: profit-gated trend-reversal exit ---
        let candles;
        try {
          candles = await fetchOHLCV(
            exchange,
            pos.symbol,
            config.timeframe,
            config.candleLimit,
          );
        } catch (err) {
          logger.warn(
            `Position monitor: could not fetch candles for ${pos.symbol}:`,
            err.message,
          );
          continue;
        }

        const tfMs = timeframeToMs(config.timeframe);
        const closed = candles.filter((c) => isCandleClosed(c, tfMs));
        if (closed.length < 30) continue;

        const closedCandleClose = closed[closed.length - 1][4];
        const ema20 = calcEMA(closed, 20);
        const rsi = calcRSI(closed);

        const reversal = checkProfitGatedReversal(
          { side: direction, entry: details.entry },
          currentPrice,
          details.atr,
          closedCandleClose,
          ema20,
          rsi,
          {
            profitAtrTrigger: mgmt.reversalProfitAtrTrigger,
            rsiLongExitMax: mgmt.reversalRsiLongExitMax,
            rsiShortExitMin: mgmt.reversalRsiShortExitMin,
          },
        );

        if (reversal.shouldExit) {
          logger.trade(
            `${pos.symbol}: profit-gated reversal exit — ${reversal.reason}. Closing now.`,
          );
          const side = direction === "long" ? "buy" : "sell";
          await trader.closePosition(pos.symbol, side, amount);
        }
      }
    } catch (err) {
      logger.error("Position monitor cycle failed:", err.message);
    }
  }, CHECK_INTERVAL_MS);

  return intervalId;
}
