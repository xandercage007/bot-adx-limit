function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function buildPortfolioSummary({ records }) {
  const {
    symbol,
    action,
    stopLoss,
    takeProfit,
    confidence,
    reason,
    entryPrice,
  } = records;
  return {
    symbol,
    action,
    stopLoss,
    takeProfit,
    confidence,
    reason,
    entryPrice,
  };
}

export async function getFuturesBalance(exchange) {
  if (!exchange || typeof exchange.fetchBalance !== "function") {
    return 0;
  }

  try {
    const balance = await exchange.fetchBalance();

    const exact =
      balance?.total?.USDT ??
      balance?.total?.usdt ??
      balance?.info?.totalWalletBalance ??
      balance?.info?.totalMarginBalance ??
      0;

    return toNumber(exact, 0);
  } catch {
    return 0;
  }
}

export function formatPortfolioSummary(summary) {
  const result = [];
  summary.forEach((item) => {
    result.push(
      [
        "<b>📊 Signal</b>",
        `SYMBOL: <b>${item.symbol}</b>`,
        `SIDE: <b>${item.action}</b>`,
        `ENTRY: <b>${item.entryPrice}</b>`,
        `SL: <b>${item.stopLoss}</b>`,
        `TP: <b>${item.takeProfit}</b>`,
        `CONFIDENCE: <b>${item.confidence}</b>`,
        `REASON: <b>${item.reason}</b>`,
        "",
        "<i>به‌روزرسانی هر 5 دقیقه</i>",
      ].join("\n"),
    );
  });
  return result;
}
export const formatPosition = (pos = []) => {
  return pos.map((item) => ({
    text: [
      "<b> Position </b>",
      `Symbol: <b>${item.symbol}</b>`,
      `Side: <b>${item.side}</b>`,
      `EntryPrice: <b>${item.entryPrice}</b>`,
      `UnrealizedPnL: <b>${item.unrealizedPnl}</b>`,
      `InitialMargin: <b>${item.initialMargin}</b>`,
      `MarkPrice: <b>${item.markPrice}</b>`,
      `Percentage: <b>${item.percentage}</b>`,
    ].join("\n"),
    symbol: item.symbol,
    side: item.side,
    amount: item.contracts,
  }));

  return result;
};
export const formatOrders = (orders = []) => {
  return orders.map((item) => ({
    text: [
      "<b>Order</b>",
      `Symbol: <b>${item.info.symbol}</b>`,
      `Side: <b>${item.info.side}</b>`,
      `EntryPrice: <b>${item.info.price}</b>`,
      `InitialMargin: <b>${item.info.marginLocked}</b>`,
    ].join("\n"),

    orderId: item.id,
    symbol: item.symbol,
  }));
};
