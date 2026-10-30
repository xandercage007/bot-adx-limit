import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  calcPositionSize,
  validateCandidate,
  computeStopTakeProfit,
} from "./riskManager.js";
import {
  markTraded,
  registerPosition,
  getPositionDetails,
  updatePositionDetails,
  clearPosition,
} from "./positionRegistry.js";
import { trackLimitEntry } from "./limitEntryManager.js";
import { appendTradeResult } from "./tradeHistory.js";
import { Order } from "./models/Orders.model.js";
import { Position } from "./models/Position.model.js";
import { TechnicalsData } from "./models/TechnicalsData.model.js";
import { TradeTelegramBot } from "./telegram/bot.js";
import { formatOrders } from "./telegram/reportBuilder.js";
// ------------------------------------------------------------------
// Places REAL orders via ccxt. With config.exchange.demoTrading = true,
// these land in Binance's Demo Trading environment (real order flow,
// fake balance). If you ever flip demoTrading to false, this same code
// trades with real money — nothing else about the flow changes.
//
// Flow: openPosition places a LIMIT entry (not market) at the 5m
// support/resistance price entryTiming.js computed → limitEntryManager.js
// polls for the fill → finalizeEntry (below) runs once it fills, computing
// the FINAL structure-based SL/TP off the real fill price and placing the
// real exchange-side exit orders.
// ------------------------------------------------------------------

export class LiveTrader {
  constructor(exchange) {
    if (config.mode !== "live") {
      throw new Error(
        "LiveTrader instantiated while config.mode !== 'live'. Refusing to proceed.",
      );
    }
    this.exchange = exchange;
  }

  async getBalance() {
    const bal = await this.exchange.fetchBalance();
    return bal?.total?.USDT ?? 0;
  }

  // Places the LIMIT entry order. Does NOT place SL/TP yet — those need the
  // real fill price, which isn't known until the limit order actually fills
  // (see finalizeEntry, called from limitEntryManager.js on fill).
  async openPosition(candidate, openPositions) {
    const { valid, reasons } = validateCandidate(candidate, openPositions);
    if (!valid) {
      logger.info(`Skipping ${candidate.symbol}: ${reasons.join("; ")}`);
      return null;
    }

    const balance = await this.getBalance();
    const leverage = Math.min(
      config.exchange.defaultLeverage,
      config.risk.maxLeverage,
    );
    const market = this.exchange.market(candidate.symbol);
    const contractSize = market.contractSize || 1;
    const sizing = calcPositionSize(
      balance,
      candidate.entry,
      candidate.stopLoss,
      leverage,
      contractSize,
    );

    if (!sizing.units || sizing.marginRequired > balance) {
      logger.info(
        `Skipping ${candidate.symbol}: insufficient margin (need ${sizing.marginRequired?.toFixed?.(2)}, have ${balance.toFixed(2)})`,
      );
      return null;
    }

    if (sizing.cappedByMargin) {
      logger.info(
        `${candidate.symbol}: position size capped by margin limit. Estimated $ risk ≈ ${sizing.riskAmount.toFixed(2)}.`,
      );
    }

    const amount = this.exchange.amountToPrecision(
      candidate.symbol,
      sizing.units,
    );
    logger.info(
      `${candidate.symbol}: sizing → margin≈${sizing.marginRequired.toFixed(2)} USDT, notional≈${sizing.notional.toFixed(2)} USDT, ` +
        `leverage=${leverage}x, contractSize=${contractSize}, amount ${sizing.units} → rounded to ${amount} ` +
        `(effective notional≈${(Number(amount) * candidate.entry * contractSize).toFixed(2)} USDT)`,
    );
    if (Number(amount) <= 0) {
      logger.warn(
        `Skipping ${candidate.symbol}: position size rounds down to 0 at this precision.`,
      );
      return null;
    }

    const side = candidate.direction === "long" ? "buy" : "sell";
    const price = this.exchange.priceToPrecision(
      candidate.symbol,
      candidate.entry,
    );

    try {
      // Defensive cleanup: cancel any leftover order on this symbol first,
      // so a stale order from a previous position can't interfere.
      try {
        const staleOrders = await this.exchange.fetchOpenOrders(
          candidate.symbol,
        );
        for (const o of staleOrders) {
          await this.exchange.cancelOrder(o.id, candidate.symbol);
          logger.info(
            `${candidate.symbol}: cancelled leftover order ${o.id} before opening new position.`,
          );
        }
      } catch (err) {
        logger.warn(
          `${candidate.symbol}: could not check/cancel leftover orders:`,
          err.message,
        );
      }

      if (this.exchange.has.setLeverage) {
        await this.exchange.setLeverage(leverage, candidate.symbol);
      }

      const entryOrder = await this.exchange.createOrder(
        candidate.symbol,
        "limit",
        side,
        amount,
        price,
        {
          stopLoss: {
            triggerPrice: this.exchange.priceToPrecision(
              candidate.symbol,
              candidate.stopLoss,
            ),
          },
          takeProfit: {
            triggerPrice: this.exchange.priceToPrecision(
              candidate.symbol,
              candidate.takeProfit,
            ),
          },
        },
      );

      const {
        symbol,
        adx,
        atr,
        direction,
        resistance,
        rsi,
        trend,
        support,
        volumeSpikeRatio,
      } = candidate;
      const technicalsData = new TechnicalsData({
        symbol,
        adx,
        atr,
        direction,
        resistance,
        rsi,
        trend,
        support,
        volumeSpikeRatio,
      });

      const order = new Order({
        entryPrice: price,
        amount,
        symbol: candidate.symbol,
        orderId: entryOrder.id,
        takeProfit: candidate.takeProfit,
        stopLoss: candidate.stopLoss,
        side,
        technicalsData: technicalsData.id,
      });
      const formatOrder = formatOrders(order.filter());
      formatOrder.forEach((item) => {
        TradeTelegramBot.sendMessageBot(`New Order: \n ${item}`);
      });
      await order.save();
      await technicalsData.save();
      logger.trade(
        `LIVE LIMIT ENTRY placed: ${side} ${amount} ${candidate.symbol} @ ${price} | orderId=${entryOrder.id}`,
      );

      trackLimitEntry(entryOrder.id, {
        symbol: candidate.symbol,
        direction: candidate.direction,
        candidate,
        amount,
        leverage,
      });

      return entryOrder;
    } catch (err) {
      logger.error(
        `Live limit entry failed for ${candidate.symbol}:`,
        err.message,
      );
      return null;
    }
  }

  // Called once the limit entry order is confirmed FILLED (from
  // limitEntryManager.js). Recomputes the structure-based SL/TP off the
  // REAL fill price and places the real exchange-side exit orders.
  async finalizeEntry({
    symbol,
    direction,
    candidate,
    amount,
    leverage,
    actualEntry,
  }) {
    markTraded(symbol);

    const levels = computeStopTakeProfit(direction, actualEntry, candidate);

    if (!levels.isValid) {
      // Extremely unlikely (the pre-fill check already validated this at a
      // very similar price), but if the structure genuinely no longer makes
      // sense at the actual fill, don't hold an unprotected position —
      // flatten it immediately instead of guessing at a stop.
      logger.error(
        `${symbol}: filled at ${actualEntry}, but structure risk is now INVALID (${levels.reason}). Closing immediately.`,
      );
      const closeSide = direction === "long" ? "sell" : "buy";
      await this.closePosition(
        symbol,
        closeSide === "sell" ? "buy" : "sell",
        amount,
      );
      return;
    }

    logger.info(
      `${symbol}: final levels from actual fill ${actualEntry.toFixed(4)} — ` +
        `SL=${levels.stopLoss.toFixed(4)} TP=${levels.takeProfit.toFixed(4)} RR=${levels.riskReward.toFixed(2)}`,
    );

    const closeSide = direction === "long" ? "sell" : "buy";
    let stopOrder = null;
    let tpOrder = null;

    if (config.exchange.attachRealStopOrders) {
      const stopPrice = this.exchange.priceToPrecision(symbol, levels.stopLoss);
      const tpPrice = this.exchange.priceToPrecision(symbol, levels.takeProfit);

      try {
        stopOrder = await this.exchange.createOrder(
          symbol,
          "STOP_MARKET",
          closeSide,
          amount,
          undefined,
          {
            stopPrice,
            reduceOnly: true,
          },
        );
        logger.trade(
          `LIVE SL SET: ${symbol} @ ${stopPrice} | orderId=${stopOrder.id}`,
        );
      } catch (err) {
        logger.error(`Failed to place STOP_MARKET for ${symbol}:`, err.message);
      }

      try {
        tpOrder = await this.exchange.createOrder(
          symbol,
          "TAKE_PROFIT_MARKET",
          closeSide,
          amount,
          undefined,
          {
            stopPrice: tpPrice,
            reduceOnly: true,
          },
        );
        logger.trade(
          `LIVE TP SET: ${symbol} @ ${tpPrice} | orderId=${tpOrder.id}`,
        );
      } catch (err) {
        logger.error(
          `Failed to place TAKE_PROFIT_MARKET for ${symbol}:`,
          err.message,
        );
      }

      if (!stopOrder || !tpOrder) {
        logger.error(
          `${symbol}: position is OPEN but SL and/or TP order failed to place. Check this position manually on Binance right now.`,
        );
      }
    } else {
      logger.warn(
        `${symbol}: attachRealStopOrders is false — no exchange-side SL/TP was placed.`,
      );
    }

    registerPosition(symbol, {
      direction,
      entry: actualEntry,
      tp: levels.takeProfit, // needed by monitorPosition's 50%-to-TP breakeven check
      atr: candidate.atr,
      amount: Number(amount),
      leverage,
      stopOrderId: stopOrder?.id ?? null,
      tpOrderId: tpOrder?.id ?? null,
      openedAt: Date.now(),
      breakevenSet: false,
    });
  }

  // Cancels the SL order and places a fresh one at `newSL` — used for the
  // breakeven guardrail (see trendMonitor.js / structureRiskManager.js
  // `monitorPosition`).
  async updateStopLoss(symbol, newSL) {
    const details = getPositionDetails(symbol);
    if (!details) {
      logger.warn(
        `${symbol}: updateStopLoss called but no position details registered — skipping.`,
      );
      return;
    }

    const closeSide = details.direction === "long" ? "sell" : "buy";

    try {
      if (details.stopOrderId) {
        try {
          await this.exchange.cancelOrder(details.stopOrderId, symbol);
        } catch (err) {
          logger.warn(
            `${symbol}: could not cancel old SL order ${details.stopOrderId} (may already be gone):`,
            err.message,
          );
        }
      }

      const stopPrice = this.exchange.priceToPrecision(symbol, newSL);
      const stopOrder = await this.exchange.createOrder(
        symbol,
        "market",
        closeSide,
        details.amount,
        undefined,
        {
          stopPrice,
          triggerPrice: stopPrice,
          stopBy: "Last",
          reduceOnly: true,
        },
      );

      logger.trade(
        `${symbol}: SL moved to breakeven @ ${stopPrice} | orderId=${stopOrder.id}`,
      );
      updatePositionDetails(symbol, {
        stopOrderId: stopOrder.id,
        breakevenSet: true,
      });
    } catch (err) {
      logger.error(`${symbol}: failed to move SL to breakeven:`, err.message);
    }
  }

  // Cancels any open reduce-only orders and market-closes a position.
  // Used for trend-reversal exits, the time-based exit, and manual
  // flattening. Logs the trade result (win/loss) to tradeHistory.js using
  // the entry price recorded in positionRegistry.js.
  async closePosition(symbol, side, amount) {
    const closeSide = side === "buy" ? "sell" : "buy";
    const details = getPositionDetails(symbol);

    try {
      const openOrders = await this.exchange.fetchOpenOrders(symbol);
      for (const o of openOrders) {
        await this.exchange.cancelOrder(o.id, symbol);
      }

      const order = await this.exchange.createOrder(
        symbol,
        "market",
        closeSide,
        amount,
        undefined,
        {
          reduceOnly: true,
        },
      );
      logger.trade(`LIVE CLOSE: ${symbol} | orderId=${order.id}`);

      if (details) {
        const exitPrice = Number(order.average || order.price);
        const pnl =
          details.direction === "long"
            ? (exitPrice - details.entry) * details.amount
            : (details.entry - exitPrice) * details.amount;

        appendTradeResult({
          symbol,
          direction: details.direction,
          entry: details.entry,
          exitPrice,
          exitReason: "manual_or_monitor_close",
          pnl,
        });
        clearPosition(symbol);
      }

      return order;
    } catch (err) {
      logger.error(`Failed to close ${symbol}:`, err.message);
      return null;
    }
  }
}
