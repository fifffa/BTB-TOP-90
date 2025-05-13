import mongoose from "mongoose";

const MONGODB_URI =
  process.env.DB_URL ||
  "mongodb+srv://whclgud112:zmfak786@cluster0.vwdo7zu.mongodb.net/?retryWrites=true&w=majority";
// const MONGODB_URI = "mongodb://127.0.0.1:27017/deputy"; // 로컬
if (!MONGODB_URI) {
  console.error("MONGODB_URI is not defined");
  throw new Error(
    "Please define the MONGODB_URI environment variable inside app.yaml"
  );
} else {
  // console.log("MONGODB_URI:", MONGODB_URI); // 환경 변수 로깅
}

/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function dbConnect() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false, // 이 옵션은 Mongoose가 몽고DB 커맨드를 버퍼링하지 않도록 합니다.
    };

    cached.promise = mongoose.connect(MONGODB_URI, opts).then((mongoose) => {
      return mongoose;
    });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

export default dbConnect;
