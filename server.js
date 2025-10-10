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

/* ----------------------- utilities ----------------------- */

// Valid UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

function normalizeIdOrUrl(raw) {
  const r = String(raw || "").trim();
  if (!r) return null;
  if (/^\d{10,}$/.test(r)) return `https://www.google.com/maps/contrib/${r}`;
  if (r.includes("google.com/maps/contrib/")) return r.replace(/\/+$/, "");
  return null;
}

function pullLevelPoints(text) {
  const levelMatch =
    /Local Guide[^\n]{0,200}?Level\s*(\d+)/i.exec(text) ||
    /Local Guide[^\n]{0,200}?[•·]\s*Level\s*(\d+)/i.exec(text);
  const level = levelMatch ? toNum(levelMatch[1]) : 0;

  const pointsMatch =
    /(\d[\d,\.]*)\s+(?:points|pts)\b/i.exec(text) ||
    /\b(?:points|pts)\b[^\d]{0,40}(\d[\d,\.]*)/i.exec(text);
  const points = pointsMatch ? toNum(pointsMatch[1]) : 0;

  return { level, points };
}

// Hard deadline guard
async function withDeadline(promise, ms, label = "operation") {
  let t;
  const gate = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, gate]); }
  finally { clearTimeout(t); }
}

/* --------------------- Chrome discovery & launch --------------------- */

function findChromeBinary() {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return override; } catch {}
  }
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
      "--no-default-browser-check",
    ],
  });
}

/* --------- browser singleton (kept warm) + idle shutdown ---------- */

let _browser = null;
let _idleTimer = null;

async function getBrowser() {
  if (_browser) return _browser;
  _browser = await launchBrowser();
  return _browser;
}
function scheduleIdleClose(ms = 60_000) {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    try { await _browser?.close(); } catch {}
    _browser = null;
    _idleTimer = null;
  }, ms);
}

/* ---------------- small in-memory cache (5 min TTL) ---------------- */

const cache = new Map(); // key -> {data, exp}
function getCache(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() > v.exp) { cache.delete(k); return null; }
  return v.data;
}
function setCache(k, data, ms = 5 * 60 * 1000) {
  cache.set(k, { data, exp: Date.now() + ms });
}

/* ---------- selectors & helpers: modal open, name, counts ---------- */

async function openStatsModal(page) {
  const chipSel = '[jsaction*="pane.profile-stats.showStats"], .uyVA9';
  // Quick attempt to click the points chip (short waits)
  try {
    await page.waitForSelector(chipSel, { timeout: 6000 });
    const chip = await page.$(chipSel);
    if (chip) { await chip.click().catch(() => {}); await sleep(800); }
  } catch {}

  // Wait for stats rows; if not found, nudge & wait again (no full reload)
  try {
    await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: 8000 });
    return true;
  } catch {
    await page.evaluate(() => window.scrollTo(0, 300));
    await sleep(700);
    await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: 6000 });
    return true;
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
        case "videos": break;
        case "captions": break;
        case "answers": out.questions = value; break;
        case "edits": out.edits = value; break;
        case "reported incorrect": out.facts = Math.max(out.facts, value); break;
        case "facts checked": out.facts = Math.max(out.facts, value); break;
        case "places added": out.placesAdded = value; break;
        case "roads added": out.roadsAdded = value; break;
        case "q&a": break;
      }
    }
    return out;
  });
}

async function extractContributorName(page) {
  const trySelectors = [
    'h1.geAzIe.fontHeadlineLarge',
    'h1[role="button"][aria-haspopup="true"]',
    '.fontHeadlineLarge',
    'header h1',
  ];
  for (const sel of trySelectors) {
    try {
      const s = await page.$eval(sel, el => (el.textContent || "").trim());
      if (s) return s;
    } catch {}
  }
  try {
    const guess = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const lines = text.split("\n").slice(0, 50).map(s => s.trim()).filter(Boolean);
      const re = /^[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){1,2}$/;
      const cand = lines.find(l => re.test(l) && !/Google Maps|My Contributions|Local Guide/i.test(l));
      return cand || null;
    });
    if (guess) return guess;
  } catch {}
  return null;
}

/* --------------------------- core scraper --------------------------- */

async function scrapeCounts(contribUrl) {
  const browser = await getBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(UA);
  await page.setViewport?.({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(25_000);
  page.setDefaultTimeout?.(15_000);

  // Avoid consent wall
  await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });

  // Block heavy assets (keep CSS)
  if (page.setRequestInterception) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font") return req.abort();
      req.continue();
    });
  }

  // Prefer the base contrib URL; fallback to /reviews only if needed
  const candidates = [
    `${contribUrl}?hl=en&gl=us&authuser=0`,
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`,
  ];

  let lastErr = null;

  for (let idx = 0; idx < candidates.length; idx++) {
    const url = candidates[idx];
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });

      // quick consent check
      const preTxt = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(preTxt)) {
        throw new Error("consent wall");
      }

      // Try to get the name early
      let nameEarly = await extractContributorName(page).catch(() => null);

      // show the numbers modal (short waits)
      await openStatsModal(page);

      // light hydration nudges
      for (let i = 0; i < 2; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 350 * (i + 1));
        await sleep(300);
      }

      // DOM (only) for categories
      const domCounts = await extractCountsFromModal(page);

      // Level/Points from text (safe)
      const bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      const { level, points } = pullLevelPoints(bodyText);

      // Finalize name (prefer early, else try again)
      let name = nameEarly;
      if (!name) { try { name = await extractContributorName(page); } catch {} }

      await ctx.close(); // close context, keep browser warm
      scheduleIdleClose(60_000);

      return {
        url,
        counts: {
          name: name || null,
          level,
          points,
          reviews: domCounts.reviews ?? 0,
          ratings: domCounts.ratings ?? 0,
          photos: domCounts.photos ?? 0,
          edits: domCounts.edits ?? 0,
          questions: domCounts.questions ?? 0,
          facts: domCounts.facts ?? 0,
          roadsAdded: domCounts.roadsAdded ?? 0,
          placesAdded: domCounts.placesAdded ?? 0,
          listsPublished: domCounts.listsPublished ?? 0,
        },
      };
    } catch (e) {
      const msg = String(e || "");
      lastErr = msg;

      // Stop early for consent wall (no point trying alt URL)
      if (/consent wall/i.test(msg)) break;

      // Only try the second candidate if the first failed due to selector/timeout
      const isSelectorTimeout = /timeout/i.test(msg) || /Waiting for selector/i.test(msg);
      if (!(isSelectorTimeout && idx === 0)) break;
      // else loop continues to try /reviews once
    }
  }

  await ctx.close().catch(() => {});
  scheduleIdleClose(60_000);
  throw new Error(`Failed to parse profile (${lastErr || "unknown"})`);
}

/* ------------------------------ routes ------------------------------ */

app.get("/localguides/summary", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) {
    return res.status(400).json({
      error: "Provide ?contrib_url=.../maps/contrib/<id> or just the numeric <id>",
    });
  }

  // cache layer
  const key = `sum:${src}`;
  const cached = getCache(key);
  if (cached) return res.json(cached);

  try {
    const { url, counts } = await withDeadline(scrapeCounts(src), 45_000, "scrapeCounts");
    const payload = {
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts,
    };
    setCache(key, payload);
    return res.json(payload);
  } catch (e) {
    // Optional: capture a screenshot for diagnostics (best-effort)
    try {
      const browser = await getBrowser();
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.goto(src, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await page.screenshot({ path: "/tmp/lg_last_error.png", fullPage: true }).catch(() => {});
      await ctx.close().catch(() => {});
      scheduleIdleClose(60_000);
    } catch {}
    return res.status(422).json({ error: String(e) });
  }
});

// Row-level diagnostics — shows exactly what we read from the modal
app.get("/localguides/diag-rows", async (req, res) => {
  try {
    const src = normalizeIdOrUrl(req.query.contrib_url);
    if (!src) return res.status(400).json({ error: "Missing ?contrib_url" });

    const browser = await getBrowser();
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });
    await page.goto(`${src}?hl=en&gl=us&authuser=0`, { waitUntil: "domcontentloaded", timeout: 20_000 });

    const name = await extractContributorName(page).catch(() => null);
    await openStatsModal(page);

    const rows = await page.evaluate(() => {
      const toNum = v => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
      return Array.from(document.querySelectorAll(".QrGqBf .nKYSz")).map(r => ({
        label: (r.querySelector(".FM5HI")?.textContent || "").trim(),
        value: toNum(r.querySelector(".AyEQdd")?.textContent || "0"),
      }));
    });

    const text = (await page.evaluate(() => document.body.innerText)) || "";
    const lp = (() => {
      const m1 = /Local Guide[^\n]{0,200}?Level\s*(\d+)/i.exec(text) ||
                 /Local Guide[^\n]{0,200}?[•·]\s*Level\s*(\d+)/i.exec(text);
      const level = m1 ? Number(String(m1[1])) : 0;
      const m2 = /(\d[\d,\.]*)\s+(?:points|pts)\b/i.exec(text);
      const points = m2 ? Number(String(m2[1]).replace(/[^\d]/g, "")) : 0;
      return { level, points };
    })();

    const headerHTML = await page.evaluate(() => {
      const el = document.querySelector('h1.geAzIe.fontHeadlineLarge') || document.querySelector('h1, .fontHeadlineLarge');
      return el ? el.outerHTML : null;
    });

    await ctx.close();
    scheduleIdleClose(60_000);
    res.json({ name, rows, levelPoints: lp, headerHTML });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

// alias for convenience (if you wired /localguides/debug on the app side)
app.get("/localguides/debug", async (req, res) => {
  req.url = req.url.replace("/localguides/debug", "/localguides/diag-rows");
  app._router.handle(req, res);
});

// Generic debug helpers
app.get("/__whoami", (_req, res) => {
  res.json({
    node: process.version,
    execPathTried: findChromeBinary(),
    cacheDirExists: fs.existsSync("/opt/render/project/src/.puppeteer-cache"),
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
    res.status(500).type("text/plain").send(String(e) });
});

// serve the last error screenshot if present
app.get("/__lastshot", (_req, res) => {
  const p = "/tmp/lg_last_error.png";
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(404).send("No screenshot");
});

app.get("/", (_req, res) => res.status(200).send("OK"));

/* ------------------------------ start ------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
