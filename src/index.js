import { config } from "./config.js";
import { logger } from "./logger.js";
import {
  createExchange,
  loadFuturesMarkets,
  getTopVolumeSymbols,
  fetchOpenPositions,
} from "./exchange.js";
import { scanUniverse } from "./scanner.js";
import { PaperAccount } from "./paperTrader.js";
import { LiveTrader } from "./liveTrader.js";
import { startPositionMonitor } from "./trendMonitor.js";
import { EntryQueue, startEntryTimingLoop } from "./entryTiming.js";
import { startLimitEntryMonitor } from "./limitEntryManager.js";
import { startOrphanOrderCleanup } from "./orderCleanup.js";
import { validateCandidate } from "./riskManager.js";
import { getGroqResult } from "./groq.js";
import redis, { connectRedis } from "./redis.js";
import { createTelegramBot } from "./telegram/bot.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every scanIntervalMinutes: find macro-directional candidates and queue
// them. Does NOT open any positions directly — that only happens once
// entryTiming.js confirms the move on the fast (5m) timeframe and computes
// a valid structure-based SL/TP for it.
async function runScanCycle(exchange, queue, getOpenPositions) {
  await connectRedis();
  const openPositions = await getOpenPositions();
  if (openPositions.length >= config.risk.maxOpenPositions) {
    logger.info("Max open positions reached — skipping scan this cycle.");
    return;
  }

  const markets = await loadFuturesMarkets(exchange);
  const symbols = await getTopVolumeSymbols(
    exchange,
    markets,
    config.universe.topN,
  );
  logger.info(`Scanning ${symbols.length} symbols (macro filters)...`);

  const candidates = await scanUniverse(exchange, symbols);
  logger.info(
    `Found ${candidates.length} directional candidate(s) passing macro filters`,
  );

  const openSymbols = new Set(openPositions.map((p) => p.symbol));
  const slotsAvailable = config.risk.maxOpenPositions - openPositions.length;

  let queued = 0;
  for (const c of candidates) {
    if (queued >= slotsAvailable) break;
    if (openSymbols.has(c.symbol) || queue.has(c.symbol)) continue;
    const {symbol,adx,atr,direction,resistance,rsi,trend,support,volumeSpikeRatio}=c
    const signal = await getGroqResult({symbol,adx,atr,direction,resistance,rsi,trend,support,volumeSpikeRatio});

    try {
      const result = await redis.set(
        `signal:${c.symbol}`,
        JSON.stringify({
          symbol: c.symbol,
          ...signal,
        }),
        {
          EX: 600,
        },
      );

      console.log("REDIS SET RESULT:", result);
    } catch (error) {
      console.error("REDIS SET ERROR:", error);
    }
    queue.add(c);
    queued += 1;
  }

  logger.info(
    `Queued ${queued} candidate(s) for ${config.entryTimeframe} entry confirmation.`,
  );
}

async function main() {
  logger.info(
    `Starting bot in ${config.mode.toUpperCase()} mode on ${config.exchange.id}`,
  );
  if (config.mode === "live" && config.exchange.demoTrading) {
    logger.info("Demo Trading is ON — real order flow, Binance demo balance.");
  }
}
const exchange = createExchange();
await exchange.loadMarkets();
let telegramBot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  try {
    telegramBot = await Promise.race([
      createTelegramBot(exchange),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Telegram startup timed out after 5s")),
          5000,
        ),
      ),
    ]);
    logger.info("Telegram bot started — 5-minute portfolio updates enabled.");
  } catch (err) {
    logger.warn("Telegram bot failed to start:", err.message);
  }
  const account = config.mode === "paper" ? new PaperAccount() : null;
  const trader = config.mode === "live" ? new LiveTrader(exchange) : null;
  const queue = new EntryQueue();

  const getOpenPositions = async () => {
    if (config.mode === "live") return fetchOpenPositions(exchange);
    return account.openPositions;
  };

  // Fires once a queued candidate's direction is CONFIRMED on the 5m
  // timeframe AND passes the structure-based RR check — places the LIMIT
  // entry order (live) or an immediate simulated fill (paper). In live
  // mode this does NOT finish opening the trade yet: the limit order still
  // has to fill (see limitEntryManager.js -> trader.finalizeEntry).
  const onConfirmed = async (candidate) => {
    const openPositions = await getOpenPositions();
    const { valid, reasons } = validateCandidate(candidate, openPositions);
    if (!valid) {
      logger.info(
        `${candidate.symbol}: confirmed but skipped — ${reasons.join("; ")}`,
      );
      return;
    }

    if (config.mode === "live") {
      await trader.openPosition(candidate, openPositions);
    } else {
      account.tryOpenPosition(candidate);
    }
  };

  startEntryTimingLoop(exchange, queue, onConfirmed);

  if (config.mode === "live") {
    // Polls placed LIMIT entry orders for fill; on fill, computes the final
    // structure-based SL/TP off the real fill price and places the real
    // exchange-side exit orders (see liveTrader.js `finalizeEntry`).
    startLimitEntryMonitor(exchange, trader.finalizeEntry.bind(trader));

    // Every 1 minute: breakeven guardrail, 6-candle time exit, and a
    // slower confirmed-1h-trend-reversal safety net (see trendMonitor.js).
    startPositionMonitor(exchange, trader);

    // Every 30s: cancels orphaned SL/TP orders once their position has
    // already closed via the other one, and logs the trade result.
    startOrphanOrderCleanup(exchange);
  }

  while (true) {
    try {
      await runScanCycle(exchange, queue, getOpenPositions);

      // Paper mode has to check its own simulated open positions for SL/TP
      // hits — in live mode this is handled by the real exchange orders.
      if (config.mode === "paper" && account.openPositions.length > 0) {
        const priceMap = {};
        for (const pos of account.openPositions) {
          try {
            const t = await exchange.fetchTicker(pos.symbol);
            priceMap[pos.symbol] = t.last;
          } catch (err) {
            logger.warn(
              `Could not fetch price for ${pos.symbol}:`,
              err.message,
            );
          }
        }
        account.checkOpenPositions(priceMap);
      }
    } catch (err) {
      logger.error("Cycle failed:", err.message);
    }
    logger.info(`Sleeping ${config.scanIntervalMinutes} minutes...`);
    await sleep(config.scanIntervalMinutes * 60 * 1000);
  }
}

main();
