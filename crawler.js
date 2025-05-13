import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js"; // 확장자 포함 권장 (ESM 기준)
import EventValue from "./models/eventValue.js";
import data from "./data.json" assert { type: "json" };
import dbConnect from "./dbConnect.js";
import HanTools from "hangul-tools";

let browser;

async function initBrowser() {
  if (browser) {
    try {
      await browser.close();
      console.log("🔄 Previous browser closed");
    } catch (error) {
      console.error("⚠ Error closing previous browser:", error.message);
    }
  }

  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.CHROME_EXECUTABLE_PATH || "/usr/bin/google-chrome-stable"
        : undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-gpu",
      "--no-zygote",
    ],
    ignoreHTTPSErrors: true,
  });

  console.log("✅ Playwright browser initialized");
}

// async function dbConnect() {
//   if (mongoose.connection.readyState !== 1) {
//     await mongoose.connect(process.env.MONGO_URI, {
//       useNewUrlParser: true,
//       useUnifiedTopology: true,
//     });
//     console.log("✅ MongoDB connected");
//   }
// }

async function blockUnwantedResources(page) {
  await page.route("**/*", (route) => {
    const blockedTypes = new Set(["image", "stylesheet", "font", "media"]);
    const blockedDomains = ["google-analytics.com", "doubleclick.net"];
    const url = route.request().url();

    if (
      blockedTypes.has(route.request().resourceType()) ||
      blockedDomains.some((domain) => url.includes(domain))
    ) {
      route.abort();
    } else {
      route.continue();
    }
  });
}

async function playerPriceValue() {
  let context;
  try {
    await initBrowser();
    context = await browser.newContext();
    const results = [];

    for (const player of data) {
      const { id } = player;
      for (let grade = 1; grade <= 13; grade++) {
        const url = `https://fconline.nexon.com/DataCenter/PlayerInfo?spid=${id}&n1Strong=${grade}`;
        const page = await context.newPage();
        await blockUnwantedResources(page);

        try {
          console.log(`🌍 Navigating to ${url}`);
          await page.goto(url, { waitUntil: "domcontentloaded" });

          await page.waitForFunction(
            () => {
              const element = document.querySelector(".txt strong");
              return (
                element &&
                element.getAttribute("title") &&
                element.getAttribute("title").trim() !== ""
              );
            },
            { timeout: 80000 }
          );

          let datacenterTitle = await page.evaluate(() => {
            const element = document.querySelector(".txt strong").textContent;
            return element;
          });

          results.push({
            id: id,
            prices: { grade, price: datacenterTitle },
          });

          console.log(`✔ ID ${id} / Grade ${grade} → ${datacenterTitle}`);
        } catch (err) {
          console.error(`❌ Error for ID ${id}, Grade ${grade}:`, err.message);
          results.push({
            id: id,
            prices: { grade, price: "Error" },
          });
        } finally {
          await page.close();
        }
      }
    }

    return results;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

async function saveToDB(results) {
  const bulkOps = results.map(({ id, prices }) => ({
    updateOne: {
      filter: { id: String(id), "prices.grade": prices.grade },
      update: {
        $set: { "prices.$[elem].price": prices.price },
      },
      arrayFilters: [{ "elem.grade": prices.grade }],
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    try {
      await Price.bulkWrite(bulkOps);
      console.log("📦 MongoDB updated");
    } catch (error) {
      console.error("❌ MongoDB bulkWrite failed:", error.message);
    }
  } else {
    console.log("⚠ No data to save");
  }
}

async function main() {
  try {
    const BTB_LIST = {
      id: "BTB TOP 100",
      updateTime: Date.now(),
      playerPrice: [],
    };
    const list = [];
    console.log("🚀 Starting Playwright crawler...");
    await dbConnect();
    const results = await playerPriceValue();
    await saveToDB(results);

    for (let result of results) {
      if (result.prices.grade === 10) {
        list.push({ id: result.id, prices: result.prices });
      }
    }

    list.sort((a, b) => {
      const positionsA = Number(
        HanTools.parseNumber(a.prices.price.replace(",", ""))
      );
      const positionsB = Number(
        HanTools.parseNumber(b.prices.price.replace(",", ""))
      );

      // // Sort in descending order based on average position value
      return positionsB - positionsA;
    });

    list.slice(0, 100);

    for (let item of list) {
      const price = await Price.find({ id: item.id });
      // console.log("price:", price);
      if (price.length > 0) {
        BTB_LIST.playerPrice.push(...price.map((p) => p._id));
      }
    }

    console.log(" ✅ Crawler finished.");
    console.log("LIST:", list);
    console.log("BTB_LIST:", BTB_LIST.playerPrice[0]);

    await EventValue.updateOne(
      { id: BTB_LIST.id }, // 조건: id가 일치하는 문서
      { $set: BTB_LIST }, // 업데이트할 데이터
      { upsert: true } // 문서가 없으면 삽입
    );
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
