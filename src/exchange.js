import ccxt from "ccxt";
import dotenv from "dotenv";
import { config } from "./config.js";
import { logger } from "./logger.js";

dotenv.config();

// ------------------------------------------------------------------
// Binance USDT-M futures, via ccxt, in Binance's own Demo Trading mode
// (exchange.enableDemoTrading(true) below). Orders are real API calls
// and go through the real order-matching/validation logic, but land in
// your demo balance, not your real one.
//
// Your Binance demo API key/secret go in .env as BINANCE_API_KEY /
// BINANCE_API_SECRET — these must be keys generated specifically for
// demo trading in the Binance UI, not your regular account keys.
//
// If you ever remove `demoTrading: true` from config.js, this becomes
// real-money live trading with no extra confirmation step. Double check
// config.js before every deploy.
// ------------------------------------------------------------------

export function createExchange() {
  const ExchangeClass = ccxt[config.exchange.id];
  if (!ExchangeClass) {
    throw new Error(
      `ccxt has no exchange id "${config.exchange.id}". Run "npm ls ccxt" and check ccxt.exchanges for the correct id.`,
    );
  }

  const exchange = new ExchangeClass({
    apiKey: process.env.TOOBIT_API_KEY || undefined,
    secret: process.env.TOOBIT_SECRET_KEY || undefined,
    enableRateLimit: true,
    options: {
      defaultType: config.exchange.defaultType, // "future" -> USDT-M futures endpoints
      recvWindow: 10000,
    },
  });

  // Binance's official demo/paper trading mode. Real order flow, fake money.
  // Requires API keys generated specifically for demo trading in the Binance UI.
  if (config.exchange.demoTrading) {
    if (typeof exchange.enableDemoTrading !== "function") {
      throw new Error(
        "config.exchange.demoTrading is true but this ccxt version's binance class " +
          "has no enableDemoTrading() method. Run `npm update ccxt` and confirm support.",
      );
    }
    exchange.enableDemoTrading(true);
    logger.info(
      "Binance demo trading mode ENABLED — orders go to Binance's demo environment.",
    );
  }

  return exchange;
}

export async function loadFuturesMarkets(exchange) {
  await exchange.loadMarkets();
  // زمان سرور Toobit
  const serverTime = await exchange.fetchTime();

  // زمان سیستم VPS
  const localTime = Date.now();
  const [withdrawals, transfers] = await Promise.all([
    exchange.fetchWithdrawals("USDT"),
    exchange.fetchTransfers("USDT"),
  ]);
  logger.info(">>>>>>>>>>>w" + JSON.stringify(withdrawals));
  logger.info(">>>>>>>>>>>t" + JSON.stringify(transfers));
  // اختلاف زمان
  const timeDifference = serverTime - localTime;

  console.log("Toobit server time:", serverTime);
  console.log("Local time:", localTime);
  console.log("Time difference:", timeDifference, "ms");

  // اعمال اختلاف ساعت در CCXT
  exchange.options.timeDifference = timeDifference;
  const markets = Object.values(exchange.markets).filter((m) => {
    if (!m.active) return false;
    if (m.quote !== config.universe.quote) return false;
    // Only perpetual (no-expiry) contracts, not spot and not dated futures
    if (!m.swap) return false;
    if (config.universe.excludeSymbols.includes(m.symbol)) return false;
    return true;
  });

  if (markets.length === 0) {
    logger.warn(
      `No perpetual markets with quote ${config.universe.quote} found. ` +
        `Check config.exchange.defaultType and that Binance actually lists these on ccxt.`,
    );
  }

  return markets;
}

export async function getTopVolumeSymbols(exchange, markets, topN) {
  const symbols = markets.map((m) => m.symbol);
  let tickers = {};
  try {
    tickers = await exchange.fetchTickers(symbols);
  } catch (err) {
    logger.error(
      "fetchTickers failed, falling back to unsorted market list:",
      err.message,
    );
    return symbols.slice(0, topN);
  }

  const ranked = Object.values(tickers)
    .filter((t) => t.quoteVolume != null)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, topN)
    .map((t) => t.symbol);

  return ranked.length > 0 ? ranked : symbols.slice(0, topN);
}

export async function fetchOHLCV(exchange, symbol, timeframe, limit) {
  return exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
}

export async function fetchLastPrice(exchange, symbol) {
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last;
}

// Source of truth for "what's open" in live mode — ask the exchange directly
// instead of trusting local state, since local state can drift (bot restarts,
// manual intervention, SL/TP fills you didn't see, etc).
export async function fetchOpenPositions(exchange) {
  if (typeof exchange.fetchPositions !== "function") {
    throw new Error(
      "This ccxt exchange build has no fetchPositions() — cannot verify open positions safely.",
    );
  }

  const positions = await exchange.fetchPositions();
  return positions.filter((p) => {
    const amt = p.contracts ?? p.contractSize ?? p.info?.positionAmt;
    return amt && Math.abs(Number(amt)) > 0;
  });
}
