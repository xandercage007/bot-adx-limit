import mongoose from "mongoose";
const { Schema } = mongoose;

const TechnicalsDataSchema = new Schema({
    symbol:{type:String},
    adx:{type:Number},
    atr:{type:Number},
    direction:{type:Number},
    resistance:{type:Number},
    rsi:{type:Number},
    trend:{type:String},
    support:{type:Number},
    volumeSpikeRatio:{type:Number},

},{timestamps: true});
export const TechnicalsData = mongoose.model("TechnicalsData", TechnicalsDataSchema);
