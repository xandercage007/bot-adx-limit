// ============================================================
// structureRiskManager.js
//
// Market-structure based exit logic for a 1h trend-following bot.
// Two pure functions, no I/O, no exchange calls — plug their outputs
// into your existing order-placement / position-monitoring code.
//
//   computeStructureRisk(...)  -> SL/TP for a NEW signal, at entry time
//   monitorPosition(...)       -> breakeven + time-exit checks for an
//                                 ALREADY-OPEN position, on each poll/candle
// ============================================================

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Highest high / lowest low over the last `lookback` candles.
 * @param {Array<Array<number>>} candles - [ts, open, high, low, close, volume], most recent last
 * @param {number} lookback
 */
function getSwingLevels(candles, lookback) {
  const recent = candles.slice(-lookback);
  const highs = recent.map((c) => c[2]);
  const lows = recent.map((c) => c[3]);
  return {
    swingHigh: Math.max(...highs),
    swingLow: Math.min(...lows),
  };
}

/**
 * Structure-based SL/TP for a new trade signal.
 *
 * @param {Array<Array<number>>} candles   - OHLCV, most recent last
 * @param {number} currentPrice            - intended entry price
 * @param {number} atr                     - current ATR (same timeframe as candles)
 * @param {number} adx                     - current ADX
 * @param {"long"|"short"} side
 * @param {object} [opts]
 * @param {number} [opts.slLookback=18]         swing lookback for SL (spec range: 15-20)
 * @param {number} [opts.tpLookback=25]         swing lookback for TP (spec range: 20-30)
 * @param {number} [opts.slAtrBuffer=0.5]       ATR multiplier buffer beyond the swing, for SL
 * @param {number} [opts.minRR=1.1]
 * @param {number} [opts.maxRR=3.0]
 * @param {number} [opts.adxTrendThreshold=20]
 * @param {number} [opts.tpFractionTrending=0.85]  used when ADX >= threshold
 * @param {number} [opts.tpFractionChoppy=0.70]    used when ADX < threshold
 * @returns {{ sl: number|null, tp: number|null, rr: number, isValid: boolean, reason?: string }}
 */
function computeStructureRisk(candles, currentPrice, atr, adx, side, opts = {}) {
  const {
    slLookback = 18,
    tpLookback = 25,
    slAtrBuffer = 0.5,
    minRR = 1.1,
    maxRR = 3.0,
    adxTrendThreshold = 20,
    tpFractionTrending = 0.85,
    tpFractionChoppy = 0.70,
  } = opts;

  if (!candles || candles.length < Math.max(slLookback, tpLookback)) {
    return { sl: null, tp: null, rr: 0, isValid: false, reason: "insufficient candle history" };
  }
  if (!atr || atr <= 0) {
    return { sl: null, tp: null, rr: 0, isValid: false, reason: "invalid ATR" };
  }
  if (side !== "long" && side !== "short") {
    return { sl: null, tp: null, rr: 0, isValid: false, reason: `unknown side "${side}"` };
  }

  const slSwing = getSwingLevels(candles, slLookback);
  const tpSwing = getSwingLevels(candles, tpLookback);

  // Choppy market (low ADX) → pull the target in, since a full 85%-of-range
  // move is unlikely during consolidation and would just tie up the trade.
  const tpFraction = adx != null && adx < adxTrendThreshold ? tpFractionChoppy : tpFractionTrending;

  let sl, tp;
  if (side === "long") {
    sl = slSwing.swingLow - slAtrBuffer * atr;
    tp = currentPrice + tpFraction * (tpSwing.swingHigh - currentPrice);
  } else {
    sl = slSwing.swingHigh + slAtrBuffer * atr;
    tp = currentPrice - tpFraction * (currentPrice - tpSwing.swingLow);
  }

  const risk = side === "long" ? currentPrice - sl : sl - currentPrice;
  const reward = side === "long" ? tp - currentPrice : currentPrice - tp;

  if (risk <= 0 || reward <= 0) {
    // Degenerate structure — e.g. price already beyond the swing level used
    // for SL, or the TP swing sits on the wrong side of entry.
    return { sl, tp, rr: 0, isValid: false, reason: "non-positive risk or reward from current structure" };
  }

  const rr = reward / risk;
  const isValid = rr >= minRR && rr <= maxRR;

  return {
    sl,
    tp,
    rr,
    isValid,
    reason: isValid ? undefined : `RR ${rr.toFixed(2)} outside [${minRR}, ${maxRR}] — skip`,
  };
}

/**
 * Breakeven + time-based exit check for an already-open position.
 * Call this every time you poll price / on every new candle close for
 * each open position.
 *
 * @param {object} position
 * @param {"long"|"short"} position.side
 * @param {number} position.entry
 * @param {number} position.openedAt        ms timestamp (Date.now()) when opened
 * @param {boolean} position.breakevenSet   set this true yourself once you apply an UPDATE_SL result
 * @param {number} currentPrice
 * @param {number} atr                      current ATR, same timeframe the position was opened on
 * @param {object} [opts]
 * @param {number} [opts.breakevenAtrTrigger=1.0]
 * @param {number} [opts.feeBufferPercent=0.05]   small buffer beyond entry to cover fees/slippage
 * @param {number} [opts.maxHoldCandles=6]
 * @param {number} [opts.candleTimeframeMs=3600000] 1h in ms — change if your bot's timeframe differs
 * @returns {{ action: "HOLD"|"UPDATE_SL"|"CLOSE_MARKET", newSL?: number, reason?: string }}
 */
function monitorPosition(position, currentPrice, atr, opts = {}) {
  const {
    breakevenAtrTrigger = 1.0,
    feeBufferPercent = 0.05,
    maxHoldCandles = 6,
    candleTimeframeMs = ONE_HOUR_MS,
  } = opts;

  const { side, entry, openedAt, breakevenSet } = position;

  // --- Time-based exit: avoid holding through trend decay ---
  const elapsedMs = Date.now() - openedAt;
  if (elapsedMs >= maxHoldCandles * candleTimeframeMs) {
    return {
      action: "CLOSE_MARKET",
      reason: `held ${maxHoldCandles}+ candles without reaching TP or breakeven`,
    };
  }

  // --- Breakeven: once price has moved 1x ATR in our favor, lock it in ---
  if (!breakevenSet && atr > 0) {
    const profitDistance = side === "long" ? currentPrice - entry : entry - currentPrice;
    if (profitDistance >= breakevenAtrTrigger * atr) {
      const feeBuffer = entry * (feeBufferPercent / 100);
      const newSL = side === "long" ? entry + feeBuffer : entry - feeBuffer;
      return {
        action: "UPDATE_SL",
        newSL,
        reason: `breakeven triggered at ${breakevenAtrTrigger}x ATR profit`,
      };
    }
  }

  return { action: "HOLD" };
}

export { computeStructureRisk, monitorPosition, getSwingLevels };

// If your project uses CommonJS instead of ES modules, replace the line
// above with:
//   module.exports = { computeStructureRisk, monitorPosition, getSwingLevels };
