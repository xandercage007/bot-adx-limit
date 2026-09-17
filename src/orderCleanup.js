import { logger } from "./logger.js";
import { fetchOpenPositions } from "./exchange.js";
import { getTradedSymbols, getPositionDetails, clearPosition } from "./positionRegistry.js";
import { appendTradeResult } from "./tradeHistory.js";

const CLEANUP_INTERVAL_MS = 30 * 1000; // 30s — faster than the 1-min position monitor,
// since a leftover order isn't just clutter: if a NEW position gets opened
// on the same symbol later, a stale SL/TP order sitting around could fire
// against it unexpectedly.

// STOP_MARKET / TAKE_PROFIT_MARKET are placed as separate reduce-only
// orders (Binance futures has no native OCO linking them), so when one
// fills, the other just sits there forever unless something cancels it.
//
// This ALSO doubles as the natural-fill trade logger: when a symbol's
// position has closed but one of its two known order ids (stopOrderId /
// tpOrderId from positionRegistry.js) is no longer open, that missing one
// is the one that filled — we fetch it to get the real exit price, compute
// pnl, and log the result via tradeHistory.js before cancelling the
// remaining orphan order.
//
// Checks open orders PER SYMBOL (only symbols this bot has actually
// traded, via positionRegistry.js) rather than fetching open orders for
// the whole account — an unscoped fetchOpenOrders() call carries a much
// higher rate-limit weight on Binance futures.
export function startOrphanOrderCleanup(exchange) {
  logger.info(`Orphan SL/TP order cleanup started — checking every ${CLEANUP_INTERVAL_MS / 1000}s`);

  const intervalId = setInterval(async () => {
    const symbols = getTradedSymbols();
    if (symbols.length === 0) return;

    try {
      const openPositions = await fetchOpenPositions(exchange);
      const openPositionSymbols = new Set(openPositions.map((p) => p.symbol));

      for (const symbol of symbols) {
        if (openPositionSymbols.has(symbol)) continue; // position still open — its orders are legit

        try {
          const orders = await exchange.fetchOpenOrders(symbol);
          const orphans = orders.filter((o) => o.reduceOnly);
          if (orphans.length === 0) continue; // already fully cleaned up (or nothing was ever placed)

          const details = getPositionDetails(symbol);

          if (details && (details.stopOrderId || details.tpOrderId)) {
            const openOrderIds = new Set(orders.map((o) => o.id));
            const filledOrderId = [details.stopOrderId, details.tpOrderId].find(
              (id) => id && !openOrderIds.has(id)
            );

            if (filledOrderId) {
              try {
                const filledOrder = await exchange.fetchOrder(filledOrderId, symbol);
                const exitPrice = Number(filledOrder.average || filledOrder.price);
                const exitReason = filledOrderId === details.stopOrderId ? "stop_loss" : "take_profit";
                const pnl =
                  details.direction === "long"
                    ? (exitPrice - details.entry) * details.amount
                    : (details.entry - exitPrice) * details.amount;

                appendTradeResult({
                  symbol,
                  direction: details.direction,
                  entry: details.entry,
                  exitPrice,
                  exitReason,
                  pnl,
                });
              } catch (err) {
                logger.warn(`Orphan cleanup: could not fetch filled order details for ${symbol}:`, err.message);
              }
            }

            clearPosition(symbol);
          }

          for (const o of orphans) {
            try {
              await exchange.cancelOrder(o.id, symbol);
              logger.trade(
                `Cancelled orphaned ${o.type || "reduce-only"} order on ${symbol} ` +
                  `(position already closed via the other order) | orderId=${o.id}`
              );
            } catch (err) {
              logger.warn(`Failed to cancel orphan order ${o.id} on ${symbol}:`, err.message);
            }
          }
        } catch (err) {
          logger.warn(`Orphan cleanup: could not check orders for ${symbol}:`, err.message);
        }
      }
    } catch (err) {
      logger.error("Orphan order cleanup cycle failed:", err.message);
    }
  }, CLEANUP_INTERVAL_MS);

  return intervalId;
}
