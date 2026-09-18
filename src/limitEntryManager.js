import { config } from "./config.js";
import { logger } from "./logger.js";

const pending = new Map(); // orderId -> { symbol, direction, candidate, amount, placedAt }

// Called by liveTrader.js right after placing a limit entry order.
export function trackLimitEntry(orderId, info) {
  pending.set(orderId, { ...info, placedAt: Date.now() });
}

// Runs a background poll that checks every `entry.limitPollSeconds` whether
// any placed limit entry order has filled yet. On fill, calls `onFilled`
// with the real fill price so the caller (liveTrader.finalizeEntry) can
// compute the FINAL SL/TP and place the real exchange-side exit orders.
// Orders that never fill within `entry.limitFillTimeoutMinutes` are
// cancelled and dropped — no point holding a stale limit order open
// indefinitely once the setup may no longer be valid.
export function startLimitEntryMonitor(exchange, onFilled) {
  const pollMs = config.entry.limitPollSeconds * 1000;
  logger.info(`Limit entry monitor started — checking every ${pollMs / 1000}s`);

  const intervalId = setInterval(async () => {
    for (const [orderId, info] of pending.entries()) {
      const waitedMs = Date.now() - info.placedAt;

      try {
        const order = await exchange.fetchOrder(orderId, info.symbol);

        const filled = order.status === "closed" || (order.filled != null && order.filled >= order.amount);
        if (filled) {
          pending.delete(orderId);
          const actualEntry = Number(order.average || order.price || info.candidate.entry);
          logger.trade(`${info.symbol}: LIMIT entry FILLED @ ${actualEntry} | orderId=${orderId}`);
          await onFilled({ ...info, actualEntry });
          continue;
        }

        if (["canceled", "cancelled", "rejected", "expired"].includes(order.status)) {
          pending.delete(orderId);
          logger.info(`${info.symbol}: limit entry order ${order.status} — dropping.`);
          continue;
        }

        if (waitedMs > config.entry.limitFillTimeoutMinutes * 60 * 1000) {
          try {
            await exchange.cancelOrder(orderId, info.symbol);
            logger.info(
              `${info.symbol}: limit entry never filled within ${config.entry.limitFillTimeoutMinutes}min — cancelled.`
            );
          } catch (err) {
            logger.warn(`${info.symbol}: failed to cancel stale limit entry order:`, err.message);
          }
          pending.delete(orderId);
        }
      } catch (err) {
        logger.warn(`Limit entry monitor: could not check order ${orderId} on ${info.symbol}:`, err.message);
      }
    }
  }, pollMs);

  return intervalId;
}
