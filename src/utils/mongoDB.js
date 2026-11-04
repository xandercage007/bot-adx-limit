import mongoose from "mongoose";

export const connection = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  return await mongoose.connect(
    process.env.DB_ADDRESS || "mongodb://127.0.0.1:27017/trade",
  );
};
