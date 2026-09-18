import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { calcPositionSize, validateCandidate } from "./riskManager.js";

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class PaperAccount {
  constructor() {
    this.stateFile = config.paper.stateFile;
    this.logFile = config.paper.tradeLogFile;
    ensureDataDir(this.stateFile);
    ensureDataDir(this.logFile);
    this.load();
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
      this.balance = raw.balance;
      this.openPositions = raw.openPositions;
    } else {
      this.balance = config.paper.startingBalanceUSDT;
      this.openPositions = [];
      this.save();
    }
  }

  save() {
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify({ balance: this.balance, openPositions: this.openPositions }, null, 2)
    );
  }

  appendTradeLog(entry) {
    let log = [];
    if (fs.existsSync(this.logFile)) {
      log = JSON.parse(fs.readFileSync(this.logFile, "utf-8"));
    }
    log.push(entry);
    fs.writeFileSync(this.logFile, JSON.stringify(log, null, 2));
  }

  tryOpenPosition(candidate) {
    const { valid, reasons } = validateCandidate(candidate, this.openPositions);
    if (!valid) {
      logger.info(`Skipping ${candidate.symbol}: ${reasons.join("; ")}`);
      return null;
    }

    const leverage = Math.min(
      config.exchange.defaultLeverage,
      config.risk.maxLeverage
    );

    const sizing = calcPositionSize(
      this.balance,
      candidate.entry,
      candidate.stopLoss,
      leverage
    );

    if (sizing.marginRequired > this.balance) {
      logger.info(
        `Skipping ${candidate.symbol}: required margin ${sizing.marginRequired.toFixed(2)} exceeds balance ${this.balance.toFixed(2)}`
      );
      return null;
    }

    if (sizing.cappedByMargin) {
      logger.info(
        `${candidate.symbol}: stop distance was tight relative to price — position size capped by ` +
          `maxMarginPercentPerTrade. Actual $ risk ≈ ${sizing.riskAmount.toFixed(2)}.`
      );
    }

    const position = {
      id: `${candidate.symbol}-${Date.now()}`,
      symbol: candidate.symbol,
      direction: candidate.direction,
      entry: candidate.entry,
      stopLoss: candidate.stopLoss,
      takeProfit: candidate.takeProfit,
      units: sizing.units,
      leverage,
      marginUsed: sizing.marginRequired,
      riskAmount: sizing.riskAmount,
      riskReward: candidate.riskReward,
      openedAt: new Date().toISOString(),
    };

    this.openPositions.push(position);
    this.balance -= sizing.marginRequired; // reserve margin
    this.save();

    logger.trade(
      `OPEN ${position.direction.toUpperCase()} ${position.symbol} | entry=${position.entry.toFixed(4)} ` +
        `SL=${position.stopLoss.toFixed(4)} TP=${position.takeProfit.toFixed(4)} ` +
        `size=${position.units.toFixed(4)} lev=${leverage}x R:R=${candidate.riskReward.toFixed(2)}`
    );

    return position;
  }

  // Call this each cycle with a { symbol: lastPrice } map to check SL/TP hits
  checkOpenPositions(priceMap) {
    const stillOpen = [];

    for (const pos of this.openPositions) {
      const price = priceMap[pos.symbol];
      if (price == null) {
        stillOpen.push(pos);
        continue;
      }

      let closed = false;
      let exitReason = null;
      let exitPrice = null;

      if (pos.direction === "long") {
        if (price <= pos.stopLoss) { closed = true; exitReason = "stop_loss"; exitPrice = pos.stopLoss; }
        else if (price >= pos.takeProfit) { closed = true; exitReason = "take_profit"; exitPrice = pos.takeProfit; }
      } else {
        if (price >= pos.stopLoss) { closed = true; exitReason = "stop_loss"; exitPrice = pos.stopLoss; }
        else if (price <= pos.takeProfit) { closed = true; exitReason = "take_profit"; exitPrice = pos.takeProfit; }
      }

      if (closed) {
        const priceDelta =
          pos.direction === "long" ? exitPrice - pos.entry : pos.entry - exitPrice;
        const pnl = priceDelta * pos.units;

        this.balance += pos.marginUsed + pnl; // return margin + pnl
        this.appendTradeLog({ ...pos, exitPrice, exitReason, pnl, closedAt: new Date().toISOString() });

        logger.trade(
          `CLOSE ${pos.direction.toUpperCase()} ${pos.symbol} | reason=${exitReason} ` +
            `exit=${exitPrice.toFixed(4)} pnl=${pnl.toFixed(2)} USDT | new balance=${this.balance.toFixed(2)}`
        );
      } else {
        stillOpen.push(pos);
      }
    }

    this.openPositions = stillOpen;
    this.save();
  }
}
