// server.js
// Render settings:
//   Build Command:
//     npm install && PUPPETEER_CACHE_DIR=/opt/render/project/src/.puppeteer-cache npx puppeteer browsers install chrome --platform=linux
//   Start Command: node ./server.js
//   Env: NODE_VERSION=20
//   Root Directory: (blank) or "."

import express from "express";
import morgan from "morgan";
import cors from "cors";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import child_process from "child_process";

const app = express();
app.use(cors());
app.use(morgan("tiny"));

/* ----------------------- small utilities ----------------------- */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeIdOrUrl(raw) {
  const r = String(raw || "").trim();
  if (!r) return null;
  if (/^\d{10,}$/.test(r)) return `https://www.google.com/maps/contrib/${r}`;
  if (r.includes("google.com/maps/contrib/")) return r.replace(/\/+$/, "");
  return null;
}

const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

/** Text parser — used mainly for Level & Points and as a fallback */
function pullCountsFrom(text) {
  const near = (label) => {
    const A = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
    const B = new RegExp(`(?:${label})[\\s\\S]{0,100}?(\\d[\\d,\\.]*)`, "i");
    const m = text.match(A) || text.match(B);
    return m ? toNum(m[1]) : 0;
  };

  const levelMatch =
    /Local Guide[^\n]{0,200}?Level\s*(\d+)/i.exec(text) ||
    /Local Guide[^\n]{0,200}?[•·]\s*Level\s*(\d+)/i.exec(text);
  const level = levelMatch ? toNum(levelMatch[1]) : 0;

  const points =
    near("(?:points|pts)") ||
    (() => {
      const m = /(\d[\d,\.]*)\s*(?:point|pts)\b/i.exec(text);
      return m ? toNum(m[1]) : 0;
    })();

  // These may be 0 here; modal extraction will override
  return {
    level,
    points,
    reviews: near("reviews?"),
    ratings: near("ratings?"),
    photos: near("photos?"),
    edits: near("edits?"),
    questions: near("answers?"),
    facts: Math.max(near("reported\\s+incorrect"), near("facts?\\s*checked")),
    roadsAdded: near("roads?\\s+added"),
    placesAdded: near("places?\\s+added"),
    listsPublished: 0
  };
}

/* --------------------- Chrome discovery & launch --------------------- */

function findChromeBinary() {
  // 1) manual override
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return override; } catch {}
  }
  // 2) project cache on Render
  const ROOT = "/opt/render/project/src/.puppeteer-cache";
  const names = new Set(["chrome", "chrome-headless-shell", "Chromium"]);
  if (fs.existsSync(ROOT)) {
    const stack = [ROOT];
    while (stack.length) {
      const dir = stack.pop();
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile() && names.has(path.basename(p))) {
          try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
        }
      }
    }
  }
  // 3) puppeteer’s own bundled path (if any)
  try {
    const p = puppeteer.executablePath();
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {}
  return null;
}

async function launchBrowser() {
  const execPath = findChromeBinary();
  if (!execPath) {
    throw new Error(
      "Chrome/Chromium not found. Build must run: `npx puppeteer browsers install chrome --platform=linux`"
    );
  }
  return puppeteer.launch({
    headless: "new",
    executablePath: execPath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
}

/* --------------------- DOM-first modal extraction --------------------- */

async function openStatsModal(page) {
  // Click the chip that opens the stats modal (your selector from the DOM dump)
  const sel = '[jsaction*="pane.profile-stats.showStats"], .uyVA9';
  const exists = await page.$(sel);
  if (exists) {
    await page.click(sel).catch(() => {});
  } else {
    // Fallback: click any element whose text contains "points"
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button,[role="button"],a,div,span')];
      const el = nodes.find(n => /points/i.test(n.textContent || ""));
      if (el) el.click();
    });
  }
  // Wait briefly for modal rows to render
  try {
    await page.waitForSelector(".QrGqBf .nKYSz", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function extractCountsFromModal(page) {
  return await page.evaluate(() => {
    const toNum = v => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
    const out = {
      reviews: 0, ratings: 0, photos: 0, edits: 0, questions: 0, facts: 0,
      roadsAdded: 0, placesAdded: 0, listsPublished: 0
    };
    const rows = Array.from(document.querySelectorAll(".QrGqBf .nKYSz"));
    for (const r of rows) {
      const label = (r.querySelector(".FM5HI")?.textContent || "").trim().toLowerCase();
      const value = toNum(r.querySelector(".AyEQdd")?.textContent || "0");
      switch (label) {
        case "reviews": out.reviews = value; break;
        case "ratings": out.ratings = value; break;
        case "photos": out.photos = value; break;
        case "videos": /* not in schema */ break;
        case "captions": /* not in schema */ break;
        case "answers": out.questions = value; break;
        case "edits": out.edits = value; break;
        case "reported incorrect": out.facts = Math.max(out.facts, value); break;
        case "facts checked": out.facts = Math.max(out.facts, value); break;
        case "places added": out.placesAdded = value; break;
        case "roads added": out.roadsAdded = value; break;
        case "q&a": /* ignore for now */ break;
      }
    }
    return out;
  });
}

/* --------------------------- core scraper --------------------------- */

async function scrapeCounts(contribUrl) {
  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(90_000);
  page.setDefaultTimeout?.(45_000);

  // Avoid consent wall
  await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });

  // Block heavy assets
  if (page.setRequestInterception) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return req.abort();
      req.continue();
    });
  }

  const candidates = [
    `${contribUrl}?hl=en&gl=us&authuser=0`,
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

      // open the Local Guide stats modal
      await openStatsModal(page);

      // small hydration nudges
      for (let i = 0; i < 2; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 350 * (i + 1));
        await sleep(600);
      }

      // Prefer DOM extraction from the modal for per-category
      const domCounts = await extractCountsFromModal(page);

      // Always parse text for Level/Points (+ fallback if modal missed something)
      let bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(bodyText)) {
        lastErr = "consent wall";
        continue;
      }
      const textCounts = pullCountsFrom(bodyText);

      // Merge: DOM wins for categories; text provides level/points
      const merged = {
        level: textCounts.level,
        points: textCounts.points,
        reviews: domCounts.reviews || textCounts.reviews || 0,
        ratings: domCounts.ratings || textCounts.ratings || 0,
        photos: domCounts.photos || textCounts.photos || 0,
        edits: domCounts.edits || textCounts.edits || 0,
        questions: domCounts.questions || textCounts.questions || 0,
        facts: domCounts.facts || textCounts.facts || 0,
        roadsAdded: domCounts.roadsAdded || textCounts.roadsAdded || 0,
        placesAdded: domCounts.placesAdded || textCounts.placesAdded || 0,
        listsPublished: domCounts.listsPublished || textCounts.listsPublished || 0
      };

      await browser.close();
      return { url, counts: merged };
    } catch (e) {
      lastErr = String(e);
      // try next candidate
    }
  }

  await browser.close();
  throw new Error(`Failed to parse profile (${lastErr || "unknown"})`);
}

/* ------------------------------ routes ------------------------------ */

app.get("/localguides/summary", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) {
    return res.status(400).json({
      error: "Provide ?contrib_url=.../maps/contrib/<id> or just the numeric <id>"
    });
  }
  try {
    const { url, counts } = await scrapeCounts(src);
    return res.json({
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts
    });
  } catch (e) {
    return res.status(422).json({ error: String(e) });
  }
});

// Debug helpers (safe to keep during dev)
app.get("/__whoami", (_req, res) => {
  res.json({
    node: process.version,
    execPathTried: findChromeBinary(),
    cacheDirExists: fs.existsSync("/opt/render/project/src/.puppeteer-cache")
  });
});

app.get("/__ls", (_req, res) => {
  try {
    if (!fs.existsSync("/opt/render/project/src/.puppeteer-cache")) {
      return res.type("text/plain").send("(no .puppeteer-cache directory)");
    }
    const out = child_process
      .execSync("ls -R /opt/render/project/src/.puppeteer-cache | head -n 400")
      .toString();
    res.type("text/plain").send(out);
  } catch (e) {
    res.status(500).type("text/plain").send(String(e));
  }
});

// Peek rendered text (if ever needed to tweak parsers)
app.get("/localguides/debug", async (req, res) => {
  try {
    const src = normalizeIdOrUrl(req.query.contrib_url);
    if (!src) return res.status(400).json({ error: "Missing ?contrib_url" });
    const browser = await launchBrowser();
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });
    const url = `${src}?hl=en&gl=us&authuser=0`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await openStatsModal(page);
    await sleep(800);
    const text = (await page.evaluate(() => document.body.innerText)) || "";
    await browser.close();
    res.json({ url, sample: text.slice(0, 2000) });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

/* ------------------------------ start ------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
