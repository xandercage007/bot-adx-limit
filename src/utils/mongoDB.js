import mongoose from "mongoose";
import { logger } from "../logger.js";
export const connection = async ()=>await mongoose
  .connect("mongodb://127.0.0.1:27017/trade")

