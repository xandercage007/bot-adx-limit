import { config } from "./config.js";
import { computeStructureRisk } from "./structureRiskManager.js";

// Thin wrapper around structureRiskManager's computeStructureRisk, feeding
// it this project's config values and the candidate's precomputed 1h data
// (candles/atr/adx, attached by scanner.js). This is now the ONLY way SL/TP
// are determined — no manual percentage mode, no plain ATR multiplier.
//
// Returns { stopLoss, takeProfit, riskReward, isValid, reason }.
export function computeStopTakeProfit(direction, entryPrice, candidate) {
  const result = computeStructureRisk(
    candidate.candles,
    entryPrice,
    candidate.atr,
    candidate.adx,
    direction,
    config.risk.structure,
  );

  return {
    stopLoss: result.sl,
    takeProfit: result.tp,
    riskReward: result.rr,
    isValid: result.isValid,
    reason: result.reason,
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
