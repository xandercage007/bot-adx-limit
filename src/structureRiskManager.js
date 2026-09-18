// ============================================================
// structureRiskManager.js
//
// Market-structure based exit logic for a 1h trend-following bot.
// Pure functions, no I/O, no exchange calls — plug their outputs into
// your existing order-placement / position-monitoring code.
//
//   computeStructureRisk(...)      -> SL/TP for a NEW signal, at entry time
//   monitorPosition(...)           -> breakeven + time-exit for an
//                                     ALREADY-OPEN position
//   checkProfitGatedReversal(...)  -> the ONLY early-exit-on-indicator path,
//                                     and it is structurally incapable of
//                                     firing while the trade is at a loss
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
 * @param {number} [opts.minRR=1.2]             trades below this RR are rejected outright
 * @param {number|null} [opts.maxRR=null]       optional upper sanity cap — null disables it
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
    minRR = 1.2,
    maxRR = null,
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
  const isValid = rr >= minRR && (maxRR == null || rr <= maxRR);

  return {
    sl,
    tp,
    rr,
    isValid,
    reason: isValid
      ? undefined
      : `RR ${rr.toFixed(2)} below minimum ${minRR}${maxRR != null ? ` or above ${maxRR}` : ""} — skip`,
  };
}

/**
 * Breakeven + time-based exit check for an already-open position.
 * NEVER closes a losing trade — the only exit path here is the
 * unconditional time-based one, which the caller should be aware can fire
 * regardless of PnL sign (see module-level notes on `CLOSE_MARKET`).
 * Breakeven only ever tightens the stop in the trade's favor.
 *
 * @param {object} position
 * @param {"long"|"short"} position.side
 * @param {number} position.entry
 * @param {number} position.tp               the position's take-profit price — used for the
 *                                            "50% of the way to TP" breakeven trigger
 * @param {number} position.openedAt         ms timestamp (Date.now()) when opened
 * @param {boolean} position.breakevenSet    set this true yourself once you apply an UPDATE_SL result
 * @param {number} currentPrice
 * @param {number} atr                       current ATR, same timeframe the position was opened on
 * @param {object} [opts]
 * @param {number} [opts.breakevenAtrTrigger=1.2]   profit (in ATR multiples) that triggers breakeven
 * @param {number} [opts.breakevenSLBufferAtr=0.15] new SL = entry ± this × ATR (never exactly at entry)
 * @param {number} [opts.maxHoldCandles=6]
 * @param {number} [opts.candleTimeframeMs=3600000] 1h in ms — change if your bot's timeframe differs
 * @returns {{ action: "HOLD"|"UPDATE_SL"|"CLOSE_MARKET", newSL?: number, reason?: string }}
 */
function monitorPosition(position, currentPrice, atr, opts = {}) {
  const {
    breakevenAtrTrigger = 1.2,
    breakevenSLBufferAtr = 0.15,
    maxHoldCandles = 6,
    candleTimeframeMs = ONE_HOUR_MS,
  } = opts;

  const { side, entry, tp, openedAt, breakevenSet } = position;

  // --- Time-based exit: avoid holding through trend decay. This is a
  // structural guard, not an indicator/trend-reversal signal, so it is
  // allowed to fire even if the trade is currently at a loss — the hard
  // stop-loss (already resting on the exchange) is what protects against
  // an unbounded loss; this just stops an undecided trade from dragging on.
  const elapsedMs = Date.now() - openedAt;
  if (elapsedMs >= maxHoldCandles * candleTimeframeMs) {
    return {
      action: "CLOSE_MARKET",
      reason: `held ${maxHoldCandles}+ candles without reaching TP or breakeven`,
    };
  }

  // --- Breakeven: trigger on EITHER of two noise-resistant conditions ---
  if (!breakevenSet && atr > 0) {
    const profitDistance = side === "long" ? currentPrice - entry : entry - currentPrice;
    const halfwayToTp = tp != null ? Math.abs(tp - entry) * 0.5 : Infinity;
    const atrTrigger = breakevenAtrTrigger * atr;

    if (profitDistance >= atrTrigger || profitDistance >= halfwayToTp) {
      // Never sit exactly at entry — push slightly past it so ordinary
      // noise around the entry price (and fees) can't tag it immediately.
      const buffer = breakevenSLBufferAtr * atr;
      const newSL = side === "long" ? entry + buffer : entry - buffer;
      const triggerReason =
        profitDistance >= atrTrigger
          ? `${breakevenAtrTrigger}x ATR profit`
          : "50% of the way to TP";

      return {
        action: "UPDATE_SL",
        newSL,
        reason: `breakeven triggered (${triggerReason})`,
      };
    }
  }

  return { action: "HOLD" };
}

/**
 * The ONLY early-exit-on-indicator path in this module, and it is
 * structurally incapable of closing a losing trade: the profit gate is
 * checked FIRST and must pass before the EMA/RSI conditions are even
 * evaluated. If the position is flat or at a loss, this always returns
 * `shouldExit: false` — that trade can only be closed by the hard
 * stop-loss sitting on the exchange (or the unconditional time exit).
 *
 * @param {object} position
 * @param {"long"|"short"} position.side
 * @param {number} position.entry
 * @param {number} currentPrice
 * @param {number} atr
 * @param {number} closedCandleClose   close of the last FULLY CLOSED 1h candle
 * @param {number} ema20               EMA20 computed on those closed candles
 * @param {number} rsi                 RSI computed on those closed candles
 * @param {object} [opts]
 * @param {number} [opts.profitAtrTrigger=0.5]  minimum profit (in ATR multiples) before this check even runs
 * @param {number} [opts.rsiLongExitMax=45]     for longs, RSI must be below this to exit
 * @param {number} [opts.rsiShortExitMin=55]    for shorts, RSI must be above this to exit
 * @returns {{ shouldExit: boolean, reason?: string }}
 */
function checkProfitGatedReversal(position, currentPrice, atr, closedCandleClose, ema20, rsi, opts = {}) {
  const { profitAtrTrigger = 0.5, rsiLongExitMax = 45, rsiShortExitMin = 55 } = opts;
  const { side, entry } = position;

  if (!atr || atr <= 0 || ema20 == null || rsi == null || closedCandleClose == null) {
    return { shouldExit: false };
  }

  const profitDistance = side === "long" ? currentPrice - entry : entry - currentPrice;

  // Gate #1 — must be meaningfully in profit. This is what makes "panic
  // selling" structurally impossible: everything below this line never
  // executes unless the trade has already proven itself.
  if (profitDistance < profitAtrTrigger * atr) {
    return { shouldExit: false };
  }

  if (side === "long") {
    const shouldExit = currentPrice > entry && closedCandleClose < ema20 && rsi < rsiLongExitMax;
    return {
      shouldExit,
      reason: shouldExit
        ? `in profit and 1h momentum faded (close < EMA20, RSI ${rsi.toFixed(1)} < ${rsiLongExitMax})`
        : undefined,
    };
  }

  const shouldExit = currentPrice < entry && closedCandleClose > ema20 && rsi > rsiShortExitMin;
  return {
    shouldExit,
    reason: shouldExit
      ? `in profit and 1h momentum faded (close > EMA20, RSI ${rsi.toFixed(1)} > ${rsiShortExitMin})`
      : undefined,
  };
}

export { computeStructureRisk, monitorPosition, checkProfitGatedReversal, getSwingLevels };

// If your project uses CommonJS instead of ES modules, replace the line
// above with:
//   module.exports = { computeStructureRisk, monitorPosition, checkProfitGatedReversal, getSwingLevels };
