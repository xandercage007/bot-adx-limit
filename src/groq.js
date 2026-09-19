import "dotenv/config";
import Groq from "groq-sdk";
import fs from "fs";
import redis from "./redis";
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});
export const getGroqResult = async (data) => {
  delete data.candles;
  delete data.score;
  delete data.htTrend;
  console.log(data);

  try {
    const response = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an pro automated trading logic analyzer. 
Analyze the input market data and output strictly valid JSON in this format:
{
  "action": "BUY" | "SELL" | "HOLD",
  "stopLoss": number,
  "takeProfit": number,
  "confidence": number,
  "reason": "short explanation"
}`,
        },
        {
          role: "user",
          content: JSON.stringify(data),
        },
      ],
    });
    const signal = JSON.parse(response.choices[0].message.content);
    console.log("Trading Signal:", signal);
    await redis.set("signal-ai", JSON.stringify(signal));
    return signal;
    // اجرای سفارش براساس سیگنال دریافت شده
    if (signal.action === "BUY" && signal.confidence > 80) {
      console.log(
        `Executing BUY order with SL: ${signal.stopLoss} and TP: ${signal.takeProfit}`,
      );
    }
  } catch (error) {
    console.log("Error GROQ:", error);
  }
};
const writeSignalFile = (result) => {
  fs.createWriteStream("signals-ai.jsonl", { flags: "a" })
    .write(result, (file) => {})
    .end((file) => {});
};
