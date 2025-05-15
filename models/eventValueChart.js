import mongoose from "mongoose";
import Price from "./price.js";

const EventValueChartSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
  },
  updateTime: {
    type: Date,
    required: true,
  },
  seasonPack: {
    type: [Object],
    packName: String,
    playerPrice: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "Price",
    },
  },
});

const EventValueChart =
  mongoose.models.EventValueChart ||
  mongoose.model("EventValueChart", EventValueChartSchema);

export default EventValueChart;
