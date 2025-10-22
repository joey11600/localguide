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
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(morgan("tiny"));
app.use((req, _res, next) => {
  // request id + timing for easier log correlation
  req._rid = (Math.random().toString(36).slice(2) + crypto.randomBytes(3).toString("hex")).toUpperCase();
  req._t0 = Date.now();
  next();
});

/* ------------ global crash guards (convert 500s into logs) ----------- */
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.stack ? err.stack : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
  // Do NOT process.exit() on Render free tier; keep browser cache warm.
});

/* ----------------------- utilities ----------------------- */

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

async function withDeadline(promise, ms, label = "operation") {
  let t;
  const gate = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, gate]);
  } finally {
    clearTimeout(t);
  }
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
        if (ent.isDirectory()) { stack.push(p); continue; }
        if (ent.isFile() && names.has(path.basename(p))) {
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
    throw new Error("Chrome/Chromium not found. Ensure build runs puppeteer browsers install.");
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
    try { await _browser?.close(); } catch (e) { console.warn("close browser err:", e?.message); }
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

/* ------------- concurrency limiter + deduped in-flight -------------- */

class Limiter {
  constructor(max = 1) { this.max = max; this.active = 0; this.waiters = []; }
  async run(task) {
    if (this.active >= this.max) await new Promise(res => this.waiters.push(res));
    this.active++;
    try { return await task(); }
    finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
const scrapeLimiter = new Limiter(Number(process.env.SCRAPE_CONCURRENCY || 1));
const inflight = new Map();
async function deduped(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { return await fn(); }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

/* ---------- selectors & helpers: modal open, name, counts ---------- */

async function openStatsModal(page, slow = false) {
  const chipSel = '[jsaction*="pane.profile-stats.showStats"], .uyVA9';
  try {
    await page.waitForSelector(chipSel, { timeout: slow ? 12000 : 6000 });
    const chip = await page.$(chipSel);
    if (chip) { await chip.click().catch(() => {}); await sleep(slow ? 1400 : 800); }
  } catch (e) {
    // no chip; keep going and try reading stats anyway
  }
  try {
    await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: slow ? 16000 : 8000 });
    return true;
  } catch {
    try {
      await page.evaluate(() => window.scrollTo(0, 300));
      await sleep(slow ? 1000 : 700);
      await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: slow ? 12000 : 6000 });
      return true;
    } catch {
      // still not found; let caller handle zero counts
      return false;
    }
  }
}

async function extractCountsFromModal(page) {
  try {
    return await page.evaluate(() => {
      const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
      const out = { reviews:0, ratings:0, photos:0, edits:0, questions:0, facts:0, roadsAdded:0, placesAdded:0, listsPublished:0 };
      const rows = Array.from(document.querySelectorAll(".QrGqBf .nKYSz"));
      for (const r of rows) {
        const label = (r.querySelector(".FM5HI")?.textContent || "").trim().toLowerCase();
        const value = toNum(r.querySelector(".AyEQdd")?.textContent || "0");
        switch (label) {
          case "reviews": out.reviews = value; break;
          case "ratings": out.ratings = value; break;
          case "photos": out.photos = value; break;
          case "answers": out.questions = value; break;
          case "edits": out.edits = value; break;
          case "reported incorrect":
          case "facts checked": out.facts = Math.max(out.facts, value); break;
          case "places added": out.placesAdded = value; break;
          case "roads added": out.roadsAdded = value; break;
          // ignore videos/captions/q&a
        }
      }
      return out;
    });
  } catch (e) {
    return { reviews:0, ratings:0, photos:0, edits:0, questions:0, facts:0, roadsAdded:0, placesAdded:0, listsPublished:0 };
  }
}

async function extractContributorName(page) {
  const sels = [
    'h1.geAzIe.fontHeadlineLarge',
    'h1[role="button"][aria-haspopup="true"]',
    '.fontHeadlineLarge',
    'header h1',
  ];
  for (const s of these(sels)) {
    try {
      const txt = await page.$eval(s, el => (el.textContent || "").trim());
      if (txt) return txt;
    } catch {}
  }
  try {
    const guess = await page.evaluate(() => {
      const text = document.body.innerText || "";
      const lines = text.split("\n").slice(0, 60).map(s => s.trim()).filter(Boolean);
      const re = /^[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){1,2}$/;
      return lines.find(l => re.test(l) && !/Google Maps|Local Guide|My Contributions/i.test(l)) || null;
    });
    if (guess) return guess;
  } catch {}
  return null;
}
function* these(arr){ for (const x of arr) yield x; }

/* --------------------------- core scraper --------------------------- */

async function scrapeCounts(contribUrl, mode = "normal") {
  const slow = String(mode || "normal") === "slow";
  const browser = await getBrowser();
  const ctx = await browser.createBrowserContext();
  let page;
  try {
    page = await ctx.newPage();

    await page.setUserAgent(UA);
    await page.setViewport?.({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    page.setDefaultNavigationTimeout?.(slow ? 45_000 : 25_000);
    page.setDefaultTimeout?.(slow ? 25_000 : 15_000);

    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });

    try {
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const t = req.resourceType();
        if (t === "image" || t === "media" || t === "font") return req.abort();
        req.continue().catch(()=>{});
      });
    } catch (e) {
      console.warn("requestInterception error:", e?.message);
    }

    const candidates = [
      `${contribUrl}?hl=en&gl=us&authuser=0`,
      `${contribUrl}/reviews?hl=en&gl=us&authuser=0`,
    ];

    let lastErr = null;

    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      try {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: slow ? 40_000 : 20_000 });
        } catch (e1) {
          if (slow) {
            await sleep(1200);
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35_000 });
          } else {
            throw e1;
          }
        }

        const preTxt = (await page.evaluate(() => document.body.innerText)) || "";
        if (/Before you continue to Google/i.test(preTxt)) throw new Error("consent wall");

        const nameEarly = await extractContributorName(page).catch(() => null);

        await openStatsModal(page, slow);

        for (let j = 0; j < 2; j++) {
          await page.evaluate((y) => window.scrollTo(0, y), 350 * (j + 1));
          await sleep(300);
        }

        const domCounts = await extractCountsFromModal(page);
        const bodyText = (await page.evaluate(() => document.body.innerText)) || "";
        const { level, points } = pullLevelPoints(bodyText);
        const name = nameEarly || (await extractContributorName(page).catch(() => null));

        return { url, counts: { name, level, points, ...domCounts } };
      } catch (e) {
        const msg = String(e?.message || e);
        lastErr = msg;
        if (/consent wall/i.test(msg)) break; // stop trying alternates
        const isTimeout = /timeout/i.test(msg) || /Waiting for selector/i.test(msg);
        if (!(isTimeout && i === 0)) break; // only try second candidate if first timed out
      }
    }

    throw new Error(`Failed to parse profile (${lastErr || "unknown"})`);
  } finally {
    try { await page?.close({ runBeforeUnload: false }); } catch {}
    try { await ctx?.close(); } catch {}
    scheduleIdleClose();
  }
}

/* ---------------------- async handler wrapper ---------------------- */

const ah = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    // ensure we never throw out of a route
    console.error(`[route error][${req._rid}]`, e?.stack || e);
    if (res.headersSent) return;
    res.status(422).json({ ok:false, code:"ROUTE_ERROR", message:String(e?.message || e) });
  });
};

/* ------------------------------ routes ------------------------------ */

app.get("/localguides/summary", ah(async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  const mode = String(req.query.mode || "").toLowerCase(); // allow ?mode=slow
  if (!src) {
    return res.status(400).json({
      ok: false,
      code: "BAD_REQUEST",
      message: "Provide ?contrib_url=.../maps/contrib/<id> or numeric id",
    });
  }

  const key = `sum:${mode}:${src}`;
  const cached = getCache(key);
  if (cached) return res.json(cached);

  const deadline = mode === "slow" ? 90_000 : 75_000;
  const { url, counts } = await withDeadline(
    deduped(key, () => scrapeLimiter.run(() => scrapeCounts(src, mode))),
    deadline,
    "scrapeCounts"
  );

  const payload = { ok: true, contribUrl: url, fetchedAt: new Date().toISOString(), ...counts };
  setCache(key, payload);
  res.json(payload);
}));

app.get("/localguides/diag-rows", ah(async (req, res) => {
  const src = normalizeIdOrUrl(req.query.attrib_url || req.query.contrib_url);
  const mode = String(req.query.mode || "").toLowerCase();
  if (!src) return res.status(400).json({ ok:false, code:"BAD_REQUEST", message:"Missing ?contrib_url" });

  const browser = await getBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(UA);
  await page.setViewport?.({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(mode === "slow" ? 45_000 : 25_000);
  page.setDefaultTimeout?.(mode === "slow" ? 25_000 : 15_000);

  await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });
  try {
    await page.setRequestInterception(true);
    page.on("request", (req2) => {
      const t = req2.resourceType();
      if (t === "image" || t === "media" || t === "font") return req2.abort();
      req2.continue().catch(()=>{});
    });
  } catch {}

  await page.goto(`${src}?hl=en&gl=us&authuser=0`, { waitUntil: "domcontentloaded" });

  const name = await extractContributorName(page).catch(() => null);
  await openStatsModal(page, mode === "slow");

  const rows = await page.evaluate(() => {
    const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
    return Array.from(document.querySelectorAll(".QrGqBf .nKYSz")).map(r => ({
      label: (r.querySelector(".FM5HI")?.textContent || "").trim(),
      value: toNum(r.querySelector(".AyEQdd")?.textContent || "0"),
    }));
  });

  const bodyText = (await page.evaluate(() => document.body.innerText)) || "";
  const levelMatch = /Local Guide[^\n]{0,200}?(?:Level|•\s*Level)\s*(\d+)/i.exec(bodyText);
  const pointsMatch = /(\d[\d,\.]*)\s+(?:points|pts)\b/i.exec(bodyText);
  const level = levelMatch ? Number(String(levelMatch[1])) : 0;
  const points = pointsMatch ? Number(String(pointsMatch[1]).replace(/[^\d]/g, "")) : 0;

  try { await page.close({ runBeforeUnload:false }); } catch {}
  try { await ctx.close(); } catch {}
  scheduleIdleClose();

  res.json({ ok:true, name, rows, level, points });
}));

// Alias for convenience
app.get("/localguides/debug", (req, res, next) => {
  try {
    req.url = req.url.replace("/localguides/debug", "/localguides/diag-rows");
    app._router.handle(req, res, next);
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ misc ------------------------------ */

app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    rid: req._rid,
    node: process.version,
    execPathTried: findChromeBinary(),
    cacheDirExists: fs.existsSync("/opt/render/project/src/.puppeteer-cache"),
  });
});

app.get("/__ls", (req, res, next) => {
  try {
    if (!fs.existsSync("/opt/render/project/src/.puppeteer-cache")) {
      return res.type("text/plain").send("(no .puppeteer-cache directory)");
    }
    const out = child_process.execSync("ls -R /opt/render/project/src/.puppeteer-cache | head -n 400").toString();
    res.type("text/plain").send(out);
  } catch (e) {
    next(e);
  }
});

app.get("/", (req, res) => {
  res.status(200).type("text/plain").send(`OK ${req._rid} in ${Date.now()-req._t0}ms`);
});

/* --------------- final Express error handler (JSON 500) ------------- */
app.use((err, req, res, _next) => {
  console.error(`[express error][${req._rid}]`, err?.stack || err);
  if (res.headersSent) return;
  res.status(500).json({ ok:false, code:"INTERNAL_ERROR", message:String(err?.message || err) });
});

/* ------------------------------ start ------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
