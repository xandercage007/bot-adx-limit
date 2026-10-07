import { Bot, GrammyError, HttpError } from "grammy"; // ۱. افزودن کلاس‌های خطا
import { config } from "../config.js";
// import { readPositions } from "../positionStore.js";
import {
  buildPortfolioSummary,
  formatPortfolioSummary,
  // getFuturesBalance,
} from "./reportBuilder.js";
import redis from "../redis.js";

export class TradeTelegramBot {
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
  }

  async start() {
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "🤖 بات گزارش ترید فعال شد.\nهر 5 دقیقه وضعیت حساب و پوزیشن‌ها ارسال می‌شود.",
      );
    });
    this.bot.command("pos", async (ctx) => {
      const pos = await this.exchange.fetchPositions();
      if (pos.length == 0) return await ctx.reply("0 Pos");
      pos
        .filter((e) => e)
        .forEach(async (p, i) => {
          await ctx.reply(`Position: ${p}`);
        });
    });
    this.bot.command("bal", async (ctx) => {
      const result = this.exchange.fetchBalance();
      await ctx.reply(
        `Balance : ${result.info.balance} || Available Balance : ${result.info.availableBalance}`,
      );
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
    this.startPeriodicReport();
  }

  startPeriodicReport() {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
    }

    this.reportTimer = setInterval(async () => {
      const report = await this.buildReportMessage();
      if (!report || report.length === 0) {
        return;
      }

      if (this.chatId) {
        try {
          report.forEach(async (item) => {
            await this.bot.api.sendMessage(this.chatId, item, {
              parse_mode: "HTML",
            });
          });
        } catch (err) {
          console.error("Telegram send failed:", err.message);
        }
      }
    }, this.intervalMs);
  }

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
