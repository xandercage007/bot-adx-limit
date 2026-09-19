function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function buildPortfolioSummary({ records }) {
  console.log("<><><><><>", records);

  const { symbol, action, stopLoss, takeProfit, confidence, reason } = records;
  return {
    symbol,
    action,
    stopLoss,
    takeProfit,
    confidence,
    reason,
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
