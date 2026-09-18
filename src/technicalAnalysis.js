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
    atr,        // 1h ATR — used by entryTiming.js to size the stop-loss
    support,    // 1h swing low — stop-loss floor for longs
    resistance, // 1h swing high — stop-loss ceiling for shorts
    trend: trendUp ? "up" : trendDown ? "down" : "flat",
  };
}
