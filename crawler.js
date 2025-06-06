import { chromium } from "playwright-core";
import mongoose from "mongoose";
import Price from "./models/price.js"; // 확장자 포함 권장 (ESM 기준)
import EventValueChart from "./models/eventValueChart.js";
import PlayerReports from "./models/playerReports.js";
// import data from "./data.json" assert { type: "json" };
import dbConnect from "./dbConnect.js";
import HanTools from "hangul-tools";
import axios from "axios";
import playerRestrictions from "./seed/playerRestrictions.json" assert { type: "json" };

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

async function playerPriceValue(data, Grade) {
  let context;
  let grades;

  if (Array.isArray(Grade)) {
    grades = [...Grade];
  } else {
    grades = [Grade];
  }

  try {
    await initBrowser();
    context = await browser.newContext();
    const results = [];

    for (const player of data) {
      if (playerRestrictions.includes(Number(player.id))) {
        continue;
      } else {
        for (let grade of grades) {
          const { id } = player;
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
            console.error(
              `❌ Error for ID ${id}, Grade ${grade}:`,
              err.message
            );
            results.push({
              id: id,
              prices: { grade, price: "Error" },
            });
          } finally {
            await page.close();
          }
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

function SortAndSlice(result, slice = 100) {
  let data = [...result];

  data.sort((a, b) => {
    const positionsA = Number(
      HanTools.parseNumber(a.prices.price.replace(",", ""))
    );
    const positionsB = Number(
      HanTools.parseNumber(b.prices.price.replace(",", ""))
    );

    // // Sort in descending order based on average position value
    console.log("positionsB:", positionsB);
    return positionsB - positionsA;
  });

  data = data.slice(0, slice);

  console.log("data:", data);

  return data;
}

const playerSearch = async (selectedSeason = "", minOvr = 0) => {
  let selectedSeasons;
  if (Array.isArray(selectedSeason)) {
    selectedSeasons = [...selectedSeason];
  } else {
    selectedSeasons = [selectedSeason];
  }
  const seasonNumbers = [];
  const inputplayer = "";

  // 이미 배열 형태로 전달된 selectedSeasons과 selectedPositions 사용

  for (let season of selectedSeasons) {
    seasonNumbers.push(Number(String(season).slice(-3)));
  }

  let playerReports = [];

  const queryCondition = [{ name: new RegExp(inputplayer) }];

  if (minOvr && minOvr > 10) {
    queryCondition.push({
      "능력치.포지션능력치.최고능력치": {
        $gte: Number(minOvr),
      },
    });
  }

  if (seasonNumbers && seasonNumbers.length > 0) {
    for (let seasonNumber of seasonNumbers) {
      seasonNumber *= 1000000;

      const seasonCondition = {
        id: {
          $gte: seasonNumber,
          $lte: seasonNumber + 999999,
        },
      };

      queryCondition.push(seasonCondition);

      let playerReport = await PlayerReports.find({
        $and: queryCondition,
      })
        .populate({
          path: "선수정보",
          populate: {
            path: "prices", // 중첩된 필드를 처리
            model: "Price",
          },
        })
        .populate({
          path: "선수정보.시즌이미지",
          populate: {
            path: "시즌이미지",
            model: "SeasonId",
          },
        })
        .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
        .limit(10000);
      queryCondition.pop();
      playerReports = playerReports.concat(playerReport);
    }
  } else {
    let playerReport = await PlayerReports.find({
      $and: queryCondition,
    })
      .populate({
        path: "선수정보",
        populate: {
          path: "prices", // 중첩된 필드를 처리
          model: "Price",
        },
      })
      .populate({
        path: "선수정보.시즌이미지",
        populate: {
          path: "시즌이미지",
          model: "SeasonId",
        },
      })
      .sort({ "능력치.포지션능력치.포지션최고능력치": -1 })
      .limit(10000);

    playerReports = playerReports.concat(playerReport);
  }

  // playerReports.sort((a, b) => {
  //   const positionsA = Number(
  //     HanTools.parseNumber(a.선수정보.prices.prices[9].price.replace(",", ""))
  //   );
  //   const positionsB = Number(
  //     HanTools.parseNumber(b.선수정보.prices.prices[9].price.replace(",", ""))
  //   );

  //   // // Sort in descending order based on average position value
  //   return positionsB - positionsA;
  // });
  return playerReports;
};

async function main() {
  try {
    const data = {
      id: "챔피언스 저니 6000p",
      updateTime: "",
      seasonPack: [],
    };

    const BTB_TOP_90 = {
      packName: "BTB Top 90",
      playerPrice: [],
    };

    const SPL_TOP_75 = {
      packName: "SPL TOP 75",
      playerPrice: [],
    };

    const HG_TOP_100 = {
      packName: "HG TOP 100",
      playerPrice: [],
    };

    const NG23_TOP_65 = {
      packName: "23NG TOP 65",
      playerPrice: [],
    };

    const LOL_FA_22HEROES_TOP_80 = {
      packName: "LOL,FA,22HEROES TOP 80",
      playerPrice: [],
    };

    const NTG_UP_VTR_MOG_LH_TKL_TOP_100 = {
      packName: "NTG,UP,VTR,MOG,LH,TKL TOP 100",
      playerPrice: [],
    };
    const UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_TOP_350 =
      {
        packName:
          "UT,JNM,24HEROES,DC,JVA,CC,FCA,23HW,HG,RTN,23HEROES,RMCF,LN,SPL,23NG,LOL,FA,23KFA,22HEROES,BTB,CAP,CFA,EBS,BOE21,NTG,UP,22KFA TOP 350",
        playerPrice: [],
      };

    const RTN_TOP_70 = {
      packName: "RTN TOP 70",
      playerPrice: [],
    };
    const RMCF_TOP_80 = {
      packName: "RMCF 포함 TOP 80",
      playerPrice: [],
    };
    const HEROES23_TOP_75 = {
      packName: "23HEROES 포함 TOP 75",
      playerPrice: [],
    };

    await dbConnect();

    // -------------------------------------- BTB TOP price 90 --------------------------------------

    const BTB_LIST = await playerSearch(256, 95); // playerSearch(시즌넘버, 최소오버롤)
    let BTB_RESULTS = await playerPriceValue(BTB_LIST, 10);
    await saveToDB(BTB_RESULTS);
    const BTB_FINAL = SortAndSlice(BTB_RESULTS, 90);
    for (let item of BTB_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        BTB_TOP_90.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...BTB_TOP_90 });

    // // -------------------------------------- SPL TOP price 75 --------------------------------------

    const SPL_LIST = await playerSearch(270, 95); // playerSearch(시즌넘버, 최소오버롤)
    let SPL_RESULTS = await playerPriceValue(SPL_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(SPL_RESULTS);
    const SPL_FINAL = SortAndSlice(SPL_RESULTS, 75); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of SPL_FINAL) {
      const playerDocs = await Price.find({ id: item.id });

      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        SPL_TOP_75.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...SPL_TOP_75 });

    // -------------------------------------- HG TOP price 100 --------------------------------------

    const HG_LIST = await playerSearch(283, 95); // playerSearch(시즌넘버, 최소오버롤)
    let HG_RESULTS = await playerPriceValue(HG_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(HG_RESULTS);
    const HG_FINAL = SortAndSlice(HG_RESULTS, 100); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of HG_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        HG_TOP_100.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...HG_TOP_100 });

    // -------------------------------------- 23NG TOP price 65 --------------------------------------

    const NG23_LIST = await playerSearch(804, 95); // playerSearch(시즌넘버, 최소오버롤)
    let NG23_RESULTS = await playerPriceValue(NG23_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(NG23_RESULTS);
    const NG23_FINAL = SortAndSlice(NG23_RESULTS, 65); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of NG23_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        NG23_TOP_65.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...NG23_TOP_65 });

    // // -------------------------------------- LOL,FA,22HEROES TOP 80 --------------------------------------

    const LOL_FA_22HEROES_LIST = await playerSearch([265, 261, 264], 95); // playerSearch(시즌넘버, 최소오버롤)
    let LOL_FA_22HEROES_RESULTS = await playerPriceValue(
      LOL_FA_22HEROES_LIST,
      10
    ); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(LOL_FA_22HEROES_RESULTS);
    const LOL_FA_22HEROES_FINAL = SortAndSlice(LOL_FA_22HEROES_RESULTS, 80); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of LOL_FA_22HEROES_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        LOL_FA_22HEROES_TOP_80.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...LOL_FA_22HEROES_TOP_80 });

    // // -------------------------------------- NTG_UP_VTR_MOG_LH_TKL TOP 100 --------------------------------------

    const NTG_UP_VTR_MOG_LH_TKL_LIST = await playerSearch(
      [249, 246, 231, 233, 234, 225],
      95
    ); // playerSearch(시즌넘버, 최소오버롤)
    let NTG_UP_VTR_MOG_LH_TKL_RESULTS = await playerPriceValue(
      NTG_UP_VTR_MOG_LH_TKL_LIST,
      10
    ); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(NTG_UP_VTR_MOG_LH_TKL_RESULTS);
    const NTG_UP_VTR_MOG_LH_TKL_FINAL = SortAndSlice(
      NTG_UP_VTR_MOG_LH_TKL_RESULTS,
      100
    ); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of NTG_UP_VTR_MOG_LH_TKL_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        NTG_UP_VTR_MOG_LH_TKL_TOP_100.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...NTG_UP_VTR_MOG_LH_TKL_TOP_100 });

    // // -------------------------------------- RTN TOP 70 --------------------------------------

    const RTN_LIST = await playerSearch(284, 95); // playerSearch(시즌넘버, 최소오버롤)
    let RTN_RESULTS = await playerPriceValue(RTN_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(RTN_RESULTS);
    const RTN_FINAL = SortAndSlice(RTN_RESULTS, 70); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of RTN_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        RTN_TOP_70.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...RTN_TOP_70 });
    // // -------------------------------------- RMCF_CAP_CFA_21KFA TOP 80 --------------------------------------

    const RMCF_LIST = await playerSearch([274, 252, 254, 294], 95); // playerSearch(시즌넘버, 최소오버롤)
    let RMCF_RESULTS = await playerPriceValue(RMCF_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(RMCF_RESULTS);
    const RMCF_FINAL = SortAndSlice(RMCF_RESULTS, 80); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of RMCF_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        RMCF_TOP_80.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...RMCF_TOP_80 });
    // // -------------------------------------- 23HEROES_BOE21_22KFA_2012KH TOP 80 --------------------------------------

    const HEROES23_LIST = await playerSearch([281, 253, 293, 247], 95); // playerSearch(시즌넘버, 최소오버롤)
    let HEROES23_RESULTS = await playerPriceValue(HEROES23_LIST, 10); // playerPriceValue(데이터 , 강화등급)
    await saveToDB(HEROES23_RESULTS);
    const HEROES23_FINAL = SortAndSlice(HEROES23_RESULTS, 75); // SortAndSlice(데이터 , 자르기숫자)
    for (let item of HEROES23_FINAL) {
      const playerDocs = await Price.find({ id: item.id });
      if (playerDocs.length > 0) {
        const playerData = {
          grade: item.prices.grade,
        };
        playerDocs.map((p) => {
          playerData.playerPrice = p._id;
        });
        HEROES23_TOP_75.playerPrice.push(playerData);
      }
    }
    data.seasonPack.push({ ...HEROES23_TOP_75 });

    // -------------------------------------- UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA TOP 70 --------------------------------------

    // const UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_LIST =
    //   await playerSearch(
    //     [
    //       814, 813, 811, 802, 801, 289, 290, 291, 283, 284, 281, 274, 268, 270,
    //       804, 265, 264, 806, 261, 256, 252, 254, 251, 253, 249, 246, 293,
    //     ],
    //     95
    //   ); // playerSearch(시즌넘버, 최소오버롤)
    // let UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_RESULTS =
    //   await playerPriceValue(
    //     UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_LIST,
    //     8
    //   ); // playerPriceValue(데이터 , 강화등급)
    // await saveToDB(
    //   UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_RESULTS
    // );
    // const UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_FINAL =
    //   SortAndSlice(
    //     UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_RESULTS,
    //     350
    //   ); // SortAndSlice(데이터 , 자르기숫자)
    // for (let item of UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_FINAL) {
    //   const playerDocs = await Price.find({ id: item.id });
    //   if (playerDocs.length > 0) {
    //     UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_TOP_350.playerPrice.push(
    //       ...playerDocs.map((p) => p._id)
    //     );
    //   }
    // }
    // data.seasonPack.push(
    //   UT_JNM_24HEROES_DC_JVA_CC_FCA_23HW_HG_RTN_23HEROES_RMCK_LN_SPL_23NG_LOL_FA_23KFA_22HEROES_BTB_CAP_CFA_EBS_BOE21_NTG_UP_22KFA_TOP_350
    // );

    const doc = await EventValueChart.findOne({ id: "챔피언스 저니 6000p" });

    let mergedSeasonPacks = [];
    const now = new Date();
    const koreaTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    if (doc) {
      // 2. 기존 seasonPack 가져오기
      const existingSeasonPacks = doc.seasonPack;

      // 3. 병합: 같은 packName이면 덮어쓰고, 없으면 추가
      mergedSeasonPacks = [...existingSeasonPacks];

      for (const incoming of data.seasonPack) {
        const index = mergedSeasonPacks.findIndex(
          (pack) => pack.packName === incoming.packName
        );

        if (index > -1) {
          // 같은 packName 있으면 덮어쓰기
          mergedSeasonPacks[index] = {
            ...mergedSeasonPacks[index],
            ...incoming,
          };
        } else {
          // 없으면 추가
          mergedSeasonPacks.push(incoming);
        }
      }
    } else {
      // 문서 없을 경우 새로 만듦
      mergedSeasonPacks = incomingSeasonPacks;
    }

    // 4. 최종 업데이트
    await EventValueChart.updateOne(
      { id: "챔피언스 저니 6000p" },
      {
        $set: {
          updateTime: koreaTime,
          seasonPack: mergedSeasonPacks,
        },
      },
      { upsert: true }
    );

    console.log("✅ Crawling process completed.");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error in crawler:", error.message);
    process.exit(1);
  }
}

main();
