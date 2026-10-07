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

// Position size in units of the base asset, sized so that if price hits
// the stop-loss, the loss equals riskPerTradePercent% of account balance —
// but capped so a single trade never uses more margin than allowed, even if
// that means the actual $ risk ends up below the target (a tight stop
// relative to price would otherwise blow the size up huge).
//
// The margin cap itself is either:
//   - a fixed dollar amount (config.risk.fixedMarginPerTradeUSDT), if set — every
//     trade uses exactly this much margin, regardless of account balance; or
//   - a % of the current balance (config.risk.maxMarginPercentPerTrade), if
//     fixedMarginPerTradeUSDT is null.
export function calcPositionSize(
  balance,
  entry,
  stopLoss,
  leverage,
  contractSize = 1,
) {
  const riskAmount = balance * (config.risk.riskPerTradePercent / 100);
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

  let units = riskAmount / priceRisk / contractSize;
  let notional = units * entry * contractSize;
  let marginRequired = notional / leverage;

  const maxMarginForTrade =
    config.risk.fixedMarginPerTradeUSDT != null
      ? config.risk.fixedMarginPerTradeUSDT
      : balance * config.risk.maxMarginPercentPerTrade;

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
    riskAmount: units * priceRisk, // actual $ risk after any capping
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
