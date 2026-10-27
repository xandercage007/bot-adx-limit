import mongoose from "mongoose";

const { Schema } = mongoose;

const PositionSchema = new Schema(
  {
    side: String,
    symbol: String,
    entryPrice: { type: Number },
    amount: { type: Number },
    takeProfit: { type: Number },
    stopLoss: { type: Number },
    unrealizedPnL: { type: Number },
    percentage: { type: Number },
    leverage: { type: Number },
    margin: { type: Number },
    openedAt: { type: Date },
  },
  { timestamps: true },
);
export const Position = mongoose.model("Position", PositionSchema);
