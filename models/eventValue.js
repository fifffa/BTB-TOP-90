import mongoose from "mongoose";
import Price from "./price.js";

const EventValueSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
  },
  updateTime: {
    type: Date,
    required: true,
  },
  playerPrice: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: "Price",
  },
});

const EventValue =
  mongoose.models.EventValue || mongoose.model("EventValue", EventValueSchema);

export default EventValue;
