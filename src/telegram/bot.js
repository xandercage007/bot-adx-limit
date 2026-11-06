import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy"; // ۱. افزودن کلاس‌های خطا
import { config } from "../config.js";
// import { readPositions } from "../positionStore.js";
import {
  buildPortfolioSummary,
  formatOrders,
  formatPortfolioSummary,
  formatPosition,
  // getFuturesBalance,
} from "./reportBuilder.js";
import redis from "../redis.js";
import { logger } from "../logger.js";
let activeBot = null;
export class TradeTelegramBot {
  static instance = null;
  constructor(exchange, options = {}) {
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set");
    }

    this.exchange = exchange;
    this.bot = new Bot(token);
    this.chatId = options.chatId || process.env.TELEGRAM_CHAT_ID;
    this.intervalMs = options.intervalMs || 5 * 60 * 1000;
    this.reportTimer = null;
    this.isReady = false;
    TradeTelegramBot.instance = this;
  }

  async start() {
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "🤖 بات گزارش ترید فعال شد.\nهر 5 دقیقه وضعیت حساب و پوزیشن‌ها ارسال می‌شود.",
      );
    });

    this.bot.command("closepos", async (ctx) => {
      const positions = await this.exchange.fetchPositions();

      for (const p of positions) {
        const amount = Number(p.contracts);
        if (!amount) continue;

        await this.exchange.createOrder(
          p.symbol,
          "market",
          p.side === "long" ? "sell" : "buy",
          amount,
          undefined,
          { reduceOnly: true },
        );
      }

      await ctx.reply("Close orders submitted.");
    });
    this.bot.command("orders", async (ctx) => {
      const inlineKeyboard = new InlineKeyboard().text("Cancel", `cancel:`);
      const orders = await this.exchange.fetchOpenOrders();
      if (orders.length == 0) return await ctx.reply("0 ORDERS");
      const result = formatOrders(orders);
      result.forEach(async (item) => {
        await ctx.reply(item.text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `Cancel`,
                  callback_data: `cancel:${item.symbol}:${item.orderId}`,
                },
              ],
            ],
          },
        });
      });
    });
    this.bot.callbackQuery(/^cancel:(.+):(.+)$/, async (ctx) => {
      const orderId = ctx.match[2];
      const symbol = ctx.match[1];
      logger.info("order id >>>>>>>>>>>" + orderId + symbol);

      await this.exchange.cancelOrder(orderId, symbol);
      await ctx.answerCallbackQuery({ text: `Order canceled` });
    });
    this.bot.callbackQuery(/^cancelP:(.+):(.+):(.+)$/, async (ctx) => {
      const symbol = ctx.match[1];
      const side = ctx.match[2];
      const amount = ctx.match[3];
      logger.info(">>>>>>>>" + symbol);
      await this.exchange.createOrder(
        symbol,
        "market",
        side === "long" ? "sell" : "buy",
        amount,
        undefined,
        { reduceOnly: true },
      );
    });
    this.bot.command("pos", async (ctx) => {
      const pos = await this.exchange.fetchPositions();
      if (pos.length == 0) return await ctx.reply("0 Pos");
      const result = formatPosition(pos);
      result.forEach(async (item) => {
        await ctx.reply(item.text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Cancel",
                  callback_data: `cancelP:${item.symbol}:${item.side}:${item.amount}`,
                },
              ],
            ],
          },
        });
      });
    });
    this.bot.command("bal", async (ctx) => {
      const result = await this.exchange.fetchBalance();
      const stringf = JSON.stringify(result);
      await ctx.reply(`Balance : \`\`\`\n${stringf}\n\`\`\``, {
        parse_mode: "Markdown",
      });
    });
    this.bot.command("status", async (ctx) => {
      const msgs = await this.buildReportMessage();
      if (!msgs || msgs.length === 0) {
        await ctx.reply("هیچ سیگنالی برای گزارش وجود ندارد.");
        return;
      }

      msgs.forEach(async (item) => {
        await ctx.reply(item, { parse_mode: "HTML" });
      });
    });

    this.bot.command("ping", async (ctx) => {
      await ctx.reply("pong");
    });
    await this.bot.api.setMyCommands([
      {
        command: "status",
        description: "Get all signals",
      },
      {
        command: "pos",
        description: "Get all positions",
      },
      {
        command: "bal",
        description: "Get all Balance",
      },
      {
        command: "orders",
        description: "get open orders",
      },
      { command: "closepos", description: "close all positions" },
      { command: "cancelord", description: "cancel all orders" },
    ]);
    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`Error while handling update ${ctx.update.update_id}:`);
      const e = err.error;
      if (e instanceof GrammyError) {
        console.error("Error in request:", e.description);
      } else if (e instanceof HttpError) {
        console.error("Could not contact Telegram:", e);
      } else {
        console.error("Unknown error:", e);
      }
    });

    // ۲. شروع روند Polling به صورت non-blocking
    this.bot
      .start({
        onStart: (botInfo) => {
          console.log(`Bot @${botInfo.username} started successfully.`);
        },
      })
      .catch((err) => {
        console.error("Bot polling error:", err);
      });

    this.isReady = true;
    // this.startPeriodicReport();
  }

  // startPeriodicReport() {
  //   if (this.reportTimer) {
  //     clearInterval(this.reportTimer);
  //   }

  //   this.reportTimer = setInterval(async () => {
  //     const report = await this.buildReportMessage();
  //     if (!report || report.length === 0) {
  //       return;
  //     }

  //     if (this.chatId) {
  //       try {
  //         report.forEach(async (item) => {
  //           await this.bot.api.sendMessage(this.chatId, item, {
  //             parse_mode: "HTML",
  //           });
  //         });
  //       } catch (err) {
  //         console.error("Telegram send failed:", err.message);
  //       }
  //     }
  //   }, this.intervalMs);
  // }

  async buildReportMessage() {
    // const records = readPositions();
    // const balanceUsdt = await getFuturesBalance(this.exchange);
    try {
      const keys = await redis.keys("signal:*");
      console.log(">>>>>>>>>>>>>", keys);
      const values = await Promise.all(keys.map((key) => redis.get(key)));
      console.log(">>>>>>>>>>>>>", values);
      const data = values.filter(Boolean).map((value) => JSON.parse(value));
      console.log(">>>>>>>>>>>>>", values);

      // const records = data.map((item) => JSON.parse(item));
      console.log("<<<<<<<<<<<|>>>>>>>>>>>>", data);

      const summary = data.map((item) =>
        buildPortfolioSummary({ records: item }),
      );
      return formatPortfolioSummary(summary);
    } catch (error) {
      console.log(error);
    }
  }

  async sendNow() {
    if (!this.chatId) {
      return;
    }

    const messages = await this.buildReportMessage();
    messages.forEach(async (item) => {
      await this.bot.api.sendMessage(this.chatId, item, {
        parse_mode: "HTML",
      });
    });
  }

  async stop() {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }

    if (this.isReady) {
      await this.bot.stop();
      this.isReady = false;
    }
  }

  static async sendMessageBot(msg = "") {
    if (!TradeTelegramBot.instance) {
      throw new Error("بات هنوز راه‌اندازی نشده است!");
    }
    await TradeTelegramBot.instance.bot.api.sendMessage(
      TradeTelegramBot.instance.chatId,
      msg,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Cancel", callback_data: "cancel_callback" }],
          ],
        },
      },
    );
  }
}
export function getActiveBot() {
  if (!activeBot) {
    throw new Error("بات هنوز راه‌اندازی نشده است!");
  }
  return activeBot;
}
export async function createTelegramBot(exchange, configOverrides = {}) {
  const bot = new TradeTelegramBot(exchange, {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    ...configOverrides,
  });

  await bot.start();
  return bot;
}
