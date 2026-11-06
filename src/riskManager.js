import { config } from "./config.js";
import { computeStructureRisk } from "./structureRiskManager.js";

// SL/TP come from market structure (structureRiskManager.js) UNLESS you set
// config.risk.stopLossPercent / takeProfitPercent. Each side is independent:
//   number > 0 -> flat % distance from the entry price for that side
//   null       -> the structure-based level (the default)
// When BOTH are set the ratio is entirely yours, so the min/max RR gate is
// skipped (otherwise a deliberate e.g. 2% stop / 0.5% target would be
// rejected forever). With only one set, the other side is still
// structure-based and the RR gate still applies.
//
// Returns { stopLoss, takeProfit, riskReward, isValid, reason }.
export function computeStopTakeProfit(direction, entryPrice, candidate) {
  const slPct =
    Number(config.risk.stopLossPercent) > 0
      ? Number(config.risk.stopLossPercent)
      : null;
  const tpPct =
    Number(config.risk.takeProfitPercent) > 0
      ? Number(config.risk.takeProfitPercent)
      : null;
  const long = direction === "long";
  const manualSL =
    slPct != null
      ? entryPrice * (long ? 1 - slPct / 100 : 1 + slPct / 100)
      : null;
  const manualTP =
    tpPct != null
      ? entryPrice * (long ? 1 + tpPct / 100 : 1 - tpPct / 100)
      : null;

  const structure = () =>
    computeStructureRisk(
      candidate.candles,
      entryPrice,
      candidate.atr,
      candidate.adx,
      direction,
      config.risk.structure,
    );

  // Nothing set: exactly the original behaviour.
  if (manualSL == null && manualTP == null) {
    const r = structure();
    return {
      stopLoss: r.sl,
      takeProfit: r.tp,
      riskReward: r.rr,
      isValid: r.isValid,
      reason: r.reason,
    };
  }

  let stopLoss = manualSL;
  let takeProfit = manualTP;
  if (manualSL == null || manualTP == null) {
    // one side still comes from market structure
    const r = structure();
    if (manualSL == null) stopLoss = r.sl;
    if (manualTP == null) takeProfit = r.tp;
    if (stopLoss == null || takeProfit == null) {
      return {
        stopLoss,
        takeProfit,
        riskReward: 0,
        isValid: false,
        reason: r.reason ?? "structure level unavailable",
      };
    }
  }

  const risk = long ? entryPrice - stopLoss : stopLoss - entryPrice;
  const reward = long ? takeProfit - entryPrice : entryPrice - takeProfit;
  if (risk <= 0 || reward <= 0) {
    return {
      stopLoss,
      takeProfit,
      riskReward: 0,
      isValid: false,
      reason: "non-positive risk or reward",
    };
  }
  const riskReward = reward / risk;

  if (manualSL != null && manualTP != null) {
    return { stopLoss, takeProfit, riskReward, isValid: true };
  }

  const { minRR, maxRR } = config.risk.structure;
  const isValid = riskReward >= minRR && (maxRR == null || riskReward <= maxRR);
  return {
    stopLoss,
    takeProfit,
    riskReward,
    isValid,
    reason: isValid
      ? undefined
      : `RR ${riskReward.toFixed(2)} outside limits (min ${minRR}${maxRR != null ? `, max ${maxRR}` : ""})`,
  };
}

// Position size, returned in the exchange's `amount` unit (contracts).
//
// FIXED-MARGIN MODE (config.risk.fixedMarginPerTradeUSDT is a number):
//   uses EXACTLY that much margin on every trade — regardless of account
//   balance and regardless of how far the stop-loss is.
//   notional = margin × leverage. The risk-% settings are ignored here.
//
// RISK-% MODE (fixedMarginPerTradeUSDT is null):
//   sized so a stop-out loses riskPerTradePercent% of balance, with margin
//   capped at maxMarginPercentPerTrade% of balance.
//
// `contractSize` converts between coin quantity and the exchange's amount
// unit (1 for Binance linear futures; check exchange.market(symbol).contractSize).
export function calcPositionSize(
  balance,
  entry,
  stopLoss,
  leverage,
  contractSize = 1,
) {
  const priceRisk = Math.abs(entry - stopLoss);
  if (priceRisk === 0) {
    return {
      units: 0,
      notional: 0,
      marginRequired: 0,
      riskAmount: 0,
      cappedByMargin: false,
    };
  }

  if (config.risk.fixedMarginPerTradeUSDT != null) {
    const marginRequired = config.risk.fixedMarginPerTradeUSDT;
    const notional = marginRequired * leverage;
    const units = notional / (entry * contractSize);
    return {
      units,
      notional,
      marginRequired,
      riskAmount: notional * (priceRisk / entry), // $ lost if the stop is hit
      cappedByMargin: false,
    };
  }

  const riskAmount = balance * (config.risk.riskPerTradePercent / 100);
  let units = riskAmount / priceRisk / contractSize;
  let notional = units * entry * contractSize;
  let marginRequired = notional / leverage;

  const maxMarginForTrade = balance * config.risk.maxMarginPercentPerTrade;
  let cappedByMargin = false;

  if (marginRequired > maxMarginForTrade) {
    const scale = maxMarginForTrade / marginRequired;
    units *= scale;
    notional *= scale;
    marginRequired = maxMarginForTrade;
    cappedByMargin = true;
  }

  return {
    units,
    notional,
    marginRequired,
    riskAmount: units * contractSize * priceRisk, // actual $ risk after any capping
    cappedByMargin,
  };
}

// Basic eligibility checks unrelated to the structure-risk math above
// (which already enforces its own RR bounds via `isValid`).
export function validateCandidate(candidate, openPositions) {
  const reasons = [];

  if (openPositions.length >= config.risk.maxOpenPositions) {
    reasons.push(
      `Max open positions (${config.risk.maxOpenPositions}) reached`,
    );
  }
  if (openPositions.some((p) => p.symbol === candidate.symbol)) {
    reasons.push(`Already have an open position on ${candidate.symbol}`);
  }

  return { valid: reasons.length === 0, reasons };
}
