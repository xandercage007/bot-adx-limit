import { computeWinRate } from "./tradeHistory.js";

const stats = computeWinRate();

console.log("=== Win Rate Report ===");
console.log(`Total trades: ${stats.totalTrades}`);
console.log(`Wins:         ${stats.wins}`);
console.log(`Losses:       ${stats.losses}`);
console.log(`Win rate:     ${stats.winRatePercent.toFixed(1)}%`);
console.log(`Total PnL:    ${stats.totalPnL.toFixed(2)} USDT`);
