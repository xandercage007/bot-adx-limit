import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { logger } from "./logger.js";

const LOG_FILE = config.tradeHistoryFile;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf-8"));
  } catch (err) {
    logger.warn("Trade history file is unreadable, starting fresh:", err.message);
    return [];
  }
}

// Appends one closed trade's result — win or loss — to the JSON log, and
// logs a running win-rate summary. `record` should include at least:
// { symbol, direction, entry, exitPrice, exitReason, pnl }.
export function appendTradeResult(record) {
  ensureDir(LOG_FILE);
  const log = readLog();
  log.push({ ...record, closedAt: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));

  const stats = computeWinRate();
  const outcome = record.pnl >= 0 ? "WIN" : "LOSS";
  logger.trade(
    `Trade result logged: ${record.symbol} ${record.direction} ${outcome} (pnl=${record.pnl.toFixed(2)}) | ` +
      `running win rate: ${stats.winRatePercent.toFixed(1)}% (${stats.wins}/${stats.totalTrades}), ` +
      `total PnL=${stats.totalPnL.toFixed(2)} USDT`
  );
}

// Reads the full trade log and returns aggregate stats.
export function computeWinRate() {
  const log = readLog();
  const wins = log.filter((t) => t.pnl > 0).length;
  const losses = log.filter((t) => t.pnl <= 0).length;
  const totalTrades = log.length;
  const totalPnL = log.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winRatePercent = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  return { totalTrades, wins, losses, winRatePercent, totalPnL };
}
