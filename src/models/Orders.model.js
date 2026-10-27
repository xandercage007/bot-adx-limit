import mongoose from "mongoose";

const { Schema } = mongoose;

const OrderSchema = new Schema(
  {
    side: String,
    symbol: String,
    entryPrice: { type: Number },
    amount: { type: Number },
    orderId: { type: Number },
    takeProfit: { type: Number },
    stopLoss: { type: Number },
    technicalsData: {
      ref: "TechnicalsData",
      type: mongoose.Schema.Types.ObjectId,
    },
  },
  { timestamps: true },
);
export const Order = mongoose.model("Orders", OrderSchema);
