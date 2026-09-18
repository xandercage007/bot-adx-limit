// In-memory registry of live positions this bot has opened this session.
//
// tradedSymbols: used by orderCleanup.js to know which symbols' orders are
// worth checking (avoids an expensive account-wide fetchOpenOrders() call).
//
// activePositions: full details per open symbol — direction, entry, ATR,
// amount, the SL/TP order ids, when it opened, and whether breakeven has
// been applied yet. Used by trendMonitor.js (breakeven/time-exit checks),
// orderCleanup.js (figuring out which side filled + logging the trade
// result), and liveTrader.js (updating the stop on breakeven).
const tradedSymbols = new Set();
const activePositions = new Map();

export function markTraded(symbol) {
  tradedSymbols.add(symbol);
}

export function getTradedSymbols() {
  return Array.from(tradedSymbols);
}

export function registerPosition(symbol, details) {
  activePositions.set(symbol, { breakevenSet: false, ...details });
}

export function getPositionDetails(symbol) {
  return activePositions.get(symbol);
}

export function updatePositionDetails(symbol, patch) {
  const existing = activePositions.get(symbol);
  if (!existing) return;
  activePositions.set(symbol, { ...existing, ...patch });
}

export function clearPosition(symbol) {
  activePositions.delete(symbol);
}

export function getAllActivePositions() {
  return Array.from(activePositions.entries()).map(([symbol, details]) => ({ symbol, ...details }));
}
