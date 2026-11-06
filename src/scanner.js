import { fetchOHLCV } from "./exchange.js";
import {
  assessDirection,
  volumeSpikeRatio,
  higherTimeframeTrend,
  detectPinBar,
  closedOnly,
  tfToMs,
} from "./technicalAnalysis.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// Produces DIRECTIONAL candidates (symbol + long/short + score) PLUS the
// raw 1h candles, ATR, and ADX that src/structureRiskManager.js needs to
// compute the actual stop-loss/take-profit later. No entry price or exact
// SL/TP number here yet — the ENTRY is timed on the 5m timeframe (see
// entryTiming.js), but the levels it uses are still 1h-structure-based.
export async function scanSymbol(exchange, symbol) {
  try {
    const candles = await fetchOHLCV(
      exchange,
      symbol,
      config.timeframe,
      config.candleLimit,
    );
    if (!candles || candles.length < 60) return null;

    const assessment = assessDirection(candles);
    if (!assessment) return null;

    // --- Pin bar check: a hammer / shooting star on the last closed 1h candles can mean the trend is turning ---
    const pinCfg = config.risk.pinBar;
    const pin =
      pinCfg && pinCfg.enabled
        ? detectPinBar(closedOnly(candles, tfToMs(config.timeframe)), pinCfg)
        : null;
    if (pin) {
      const againstSetup =
        (assessment.direction === "short" && pin.type === "bullish") ||
        (assessment.direction === "long" && pin.type === "bearish");
      if (againstSetup) {
        if (pinCfg.onConflict === "flip") {
          const flipped = pin.type === "bullish" ? "long" : "short";
          logger.info(
            `${symbol}: ${pin.type} pin bar (${pin.candlesAgo} candle(s) ago) against the ${assessment.direction} setup — flipping to ${flipped}`,
          );
          assessment.direction = flipped;
          assessment.pinBarFlip = true;
        } else {
          logger.info(
            `${symbol}: rejected — ${pin.type} pin bar against the ${assessment.direction} setup`,
          );
          return null;
        }
      }
    }
    // --- Filter 1: ADX — only consider symbols where the 1h market is trending ---
    if (assessment.adx == null || assessment.adx < config.risk.minADX) {
      logger.info(
        `${symbol}: rejected — ADX ${assessment.adx?.toFixed?.(1) ?? "n/a"} below minimum ${config.risk.minADX} (choppy/ranging)`,
      );
      return null;
    }

    // --- Filter 2: Volume confirmation ---
    const volSpike = volumeSpikeRatio(candles);
    if (volSpike < config.risk.minVolumeSpike) {
      logger.info(
        `${symbol}: rejected — volume spike ${volSpike.toFixed(2)}x below minimum ${config.risk.minVolumeSpike}x`,
      );
      return null;
    }

    // --- Filter 3: Higher-timeframe (4h) trend must not directly conflict ---
    const htCandles = await fetchOHLCV(
      exchange,
      symbol,
      config.htTimeframe,
      config.htCandleLimit,
    );
    if (!htCandles || htCandles.length < 60) return null;

    const htTrend = higherTimeframeTrend(htCandles);
    const htConflicts =
      (assessment.direction === "long" && htTrend === "down") ||
      (assessment.direction === "short" && htTrend === "up");

    if (htConflicts) {
      logger.info(
        `${symbol}: rejected — 1h setup is ${assessment.direction} but ${config.htTimeframe} trend is ${htTrend}`,
      );
      return null;
    }

    // Composite score for ranking candidates against each other.
    const adxScore = Math.min(assessment.adx / 50, 1);
    const volScore = Math.min(volSpike / 3, 1);
    const score = adxScore * 0.6 + volScore * 0.4;

    return {
      symbol,
      direction: assessment.direction,
      rsi: assessment.rsi,
      adx: assessment.adx,
      atr: assessment.atr,
      support: assessment.support,
      resistance: assessment.resistance,
      trend: assessment.trend,
      htTrend,
      volumeSpikeRatio: volSpike,
      score,
      pinBar: pin
        ? {
            type: pin.type,
            candlesAgo: pin.candlesAgo,
            flipped: Boolean(assessment.pinBarFlip),
          }
        : null,
      candles, // raw 1h OHLCV — needed by structureRiskManager.js for its own swing-high/low lookbacks
    };
  } catch (err) {
    logger.warn(`scanSymbol failed for ${symbol}:`, err.message);
    return null;
  }
}

export async function scanUniverse(exchange, symbols) {
  const candidates = [];
  for (const symbol of symbols) {
    const result = await scanSymbol(exchange, symbol);
    if (result) candidates.push(result);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
