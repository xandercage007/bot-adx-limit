import { ATR, RSI, EMA, ADX } from "technicalindicators";

// candles: array of [timestamp, open, high, low, close, volume] from ccxt fetchOHLCV

export function splitCandles(candles) {
  return {
    open: candles.map((c) => c[1]),
    high: candles.map((c) => c[2]),
    low: candles.map((c) => c[3]),
    close: candles.map((c) => c[4]),
    volume: candles.map((c) => c[5]),
  };
}

export function calcATR(candles, period = 14) {
  const { high, low, close } = splitCandles(candles);
  const values = ATR.calculate({ period, high, low, close });
  return values[values.length - 1];
}

export function calcRSI(candles, period = 14) {
  const { close } = splitCandles(candles);
  const values = RSI.calculate({ period, values: close });
  return values[values.length - 1];
}

export function calcEMA(candles, period) {
  const { close } = splitCandles(candles);
  const values = EMA.calculate({ period, values: close });
  return values[values.length - 1];
}

// Average Directional Index — measures trend STRENGTH (not direction).
// Below ~20 usually means a ranging/choppy market where EMA crossovers
// tend to whipsaw. Above ~25 means there's an actual trend worth trading.
export function calcADX(candles, period = 14) {
  const { high, low, close } = splitCandles(candles);
  const values = ADX.calculate({ period, high, low, close });
  const last = values[values.length - 1];
  return last ? last.adx : null;
}

// Volume spike ratio: last candle volume vs average of prior N
export function volumeSpikeRatio(candles, lookback = 20) {
  const recent = candles.slice(-(lookback + 1));
  const last = recent[recent.length - 1][5];
  const prior = recent.slice(0, -1);
  const avg = prior.reduce((s, c) => s + c[5], 0) / prior.length;
  if (!avg) return 0;
  return last / avg;
}

// Higher-timeframe trend direction, used to only take trades aligned
// with the bigger picture (e.g. don't long 1h if 4h is clearly down).
export function higherTimeframeTrend(htCandles) {
  const ema20 = calcEMA(htCandles, 20);
  const ema50 = calcEMA(htCandles, 50);
  if (!ema20 || !ema50) return "unknown";
  if (ema20 > ema50) return "up";
  if (ema20 < ema50) return "down";
  return "flat";
}

// Supertrend — an ATR-based trend indicator that reacts faster than a plain
// EMA cross and gives a clean binary up/down flip. Better suited than EMA
// crossovers for short-timeframe (e.g. 5m) entry confirmation, since it
// adapts its bands to recent volatility instead of lagging behind price.
// Returns { trend: "up" | "down", upperBand, lowerBand } for the LAST candle.
export function calcSupertrend(candles, period = 10, multiplier = 3) {
  const { high, low, close } = splitCandles(candles);
  const atrValues = ATR.calculate({ period, high, low, close });
  if (atrValues.length === 0) return null;

  const offset = candles.length - atrValues.length;
  let trend = "up";
  let finalUpperBand = null;
  let finalLowerBand = null;

  for (let i = 0; i < atrValues.length; i++) {
    const idx = i + offset;
    const atr = atrValues[i];
    const mid = (high[idx] + low[idx]) / 2;
    const basicUpperBand = mid + multiplier * atr;
    const basicLowerBand = mid - multiplier * atr;

    if (i === 0) {
      finalUpperBand = basicUpperBand;
      finalLowerBand = basicLowerBand;
      trend = close[idx] > finalUpperBand ? "up" : "down";
      continue;
    }

    finalUpperBand =
      basicUpperBand < finalUpperBand || close[idx - 1] > finalUpperBand
        ? basicUpperBand
        : finalUpperBand;
    finalLowerBand =
      basicLowerBand > finalLowerBand || close[idx - 1] < finalLowerBand
        ? basicLowerBand
        : finalLowerBand;

    if (trend === "up" && close[idx] < finalLowerBand) trend = "down";
    else if (trend === "down" && close[idx] > finalUpperBand) trend = "up";
  }

  return { trend, upperBand: finalUpperBand, lowerBand: finalLowerBand };
}

// Simple swing high/low support & resistance from the last N candles —
// used as a floor/ceiling on the stop-loss so it never sits inside recent
// price structure.
export function findSwingLevels(candles, lookback = 40) {
  const recent = candles.slice(-lookback);
  const highs = recent.map((c) => c[2]);
  const lows = recent.map((c) => c[3]);
  return {
    resistance: Math.max(...highs),
    support: Math.min(...lows),
  };
}

// Given entry/stop/target, return the reward:risk ratio (e.g. 2.0 = 2:1)
export function riskRewardRatio(entry, stopLoss, takeProfit) {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk === 0) return 0;
  return reward / risk;
}

// --- MACRO direction assessment (1h) ---
// Decides WHICH WAY to trade, AND the stop-loss inputs (1h ATR + swing
// support/resistance) — because stop-loss should reflect 1h volatility,
// the timeframe the trade is actually "based on". The 5m timeframe is used
// ONLY to time the entry (see entryTiming.js) — it never sets the
// stop-loss or take-profit distance.
export function assessDirection(candles) {
  const rsi = calcRSI(candles);
  const ema20 = calcEMA(candles, 20);
  const ema50 = calcEMA(candles, 50);
  const adx = calcADX(candles);
  const atr = calcATR(candles);
  const { support, resistance } = findSwingLevels(candles);
  const lastClose = candles[candles.length - 1][4];

  if (!rsi || !ema20 || !ema50 || !atr) return null;

  const trendUp = ema20 > ema50;
  const trendDown = ema20 < ema50;

  let direction = null;
  if (trendUp && rsi < 65 && lastClose > ema20) direction = "long";
  if (trendDown && rsi > 35 && lastClose < ema20) direction = "short";
  if (!direction) return null;

  return {
    direction,
    rsi,
    adx,
    atr, // 1h ATR — used by entryTiming.js to size the stop-loss
    support, // 1h swing low — stop-loss floor for longs
    resistance, // 1h swing high — stop-loss ceiling for shorts
    trend: trendUp ? "up" : trendDown ? "down" : "flat",
  };
}

// ---- Pin bar (hammer / shooting star) detection -------------------------

// Closed-candle helpers (distinct names so they can't clash with anything already in the project).
export function tfToMs(tf) {
  const unit = tf.slice(-1);
  const n = parseInt(tf, 10);
  const map = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return n * (map[unit] || map.h);
}

// Drops the still-forming candle (and anything else not yet closed).
export function closedOnly(candles, timeframeMs) {
  return candles.filter((c) => Date.now() >= c[0] + timeframeMs);
}

// Looks for a pin bar among the last `cfg.recentCandles` CLOSED candles (the
// most recent one wins).
//   bullish ("hammer"):        long LOWER wick, small body near the top
//                              -> buyers rejected the lower prices
//   bearish ("shooting star"): long UPPER wick, small body near the bottom
//                              -> sellers rejected the higher prices
// A pin bar only means something where it prints, so by default it must also
// make a new extreme (bullish: lowest low, bearish: highest high) versus the
// previous `cfg.extremeLookback` candles, and it is dropped once price has
// CLOSED beyond its tail afterwards (the idea has failed).
// Returns { type, candlesAgo, high, low } or null.
export function detectPinBar(closed, cfg) {
  const atr = calcATR(closed);
  if (!atr) return null;
  const n = closed.length;

  for (let back = 0; back < cfg.recentCandles; back++) {
    const i = n - 1 - back;
    if (i < cfg.extremeLookback) break;

    const [, open, high, low, close] = closed[i];
    const range = high - low;
    if (range <= 0 || range < cfg.minRangeAtr * atr) continue;

    const upperWick = (high - Math.max(open, close)) / range;
    const lowerWick = (Math.min(open, close) - low) / range;
    let type = null;
    if (lowerWick >= cfg.minWickRatio && upperWick <= cfg.maxOppositeWickRatio)
      type = "bullish";
    else if (
      upperWick >= cfg.minWickRatio &&
      lowerWick <= cfg.maxOppositeWickRatio
    )
      type = "bearish";
    if (!type) continue;

    if (cfg.requireAtExtreme) {
      const before = closed.slice(i - cfg.extremeLookback, i);
      if (type === "bullish" && low > Math.min(...before.map((c) => c[3])))
        continue;
      if (type === "bearish" && high < Math.max(...before.map((c) => c[2])))
        continue;
    }

    const later = closed.slice(i + 1);
    if (type === "bullish" && later.some((c) => c[4] < low)) continue;
    if (type === "bearish" && later.some((c) => c[4] > high)) continue;

    return { type, candlesAgo: back, high, low };
  }
  return null;
}
