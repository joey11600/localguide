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

// ✅ fix UA (your previous UA had AppleWebKit(537.36) typo)
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

/** ONLY parse Level & Points from visible text (avoid false matches in categories). */
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

/* ---------- selectors & helpers: modal open, name, counts ---------- */

async function openStatsModal(page) {
  const chipSel = '[jsaction*="pane.profile-stats.showStats"], .uyVA9';
  try {
    // Wait for the points chip to exist (Google sometimes lazy-renders)
    await page.waitForSelector(chipSel, { timeout: 15000 });
    const chip = await page.$(chipSel);
    if (chip) {
      await chip.click().catch(() => {});
      await page.waitForTimeout(2000); // allow popup to animate
    } else {
      // Fallback: try clicking any visible element containing "points"
      await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('button,[role="button"],a,div,span')];
        const el = nodes.find(n => /points/i.test(n.textContent || ""));
        if (el) el.click();
      });
      await page.waitForTimeout(2000);
    }

    // Wait for the stats container to appear
    await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: 20000 });
    return true;
  } catch (err) {
    console.warn("Stats modal not found on first try:", err);
    // Retry once after reload — handles slow renders or animation delays
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const chip = await page.$(chipSel);
    if (chip) {
      await chip.click().catch(() => {});
      await page.waitForTimeout(2000);
    }
    await page.waitForSelector('.QrGqBf .nKYSz .FM5HI', { timeout: 20000 });
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
        case "videos": break;           // not stored
        case "captions": break;         // not stored
        case "answers": out.questions = value; break;
        case "edits": out.edits = value; break;
        case "reported incorrect": out.facts = Math.max(out.facts, value); break;
        case "facts checked": out.facts = Math.max(out.facts, value); break;
        case "places added": out.placesAdded = value; break;
        case "roads added": out.roadsAdded = value; break;
        case "q&a": break;              // not stored
      }
    }
    return out;
  });
}

async function extractContributorName(page) {
  // Try explicit header first
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
  // Fallback: scan a few obvious containers for a likely name (two words, letters only)
  try {
    const guess = await page.evaluate(() => {
      const text = document.body.innerText || "";
      // look for a "Firstname Lastname" style near top of page text
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
  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  await page.setUserAgent(UA);
  await page.setViewport?.({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(90_000);
  page.setDefaultTimeout?.(45_000);

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

  const candidates = [
    `${contribUrl}?hl=en&gl=us&authuser=0`,
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`,
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

      // Try to get the name as soon as the page text is there
      let nameEarly = await extractContributorName(page).catch(() => null);

      await openStatsModal(page); // show the numbers modal

      // light hydration nudges
      for (let i = 0; i < 2; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 350 * (i + 1));
        await sleep(500);
      }

      // DOM (only) for categories
      const domCounts = await extractCountsFromModal(page);

      // Level/Points from text (safe)
      let bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(bodyText)) {
        lastErr = "consent wall";
        continue;
      }
      const { level, points } = pullLevelPoints(bodyText);

      // Finalize name (prefer early, else try again)
      let name = nameEarly;
      if (!name) {
        try { name = await extractContributorName(page); } catch {}
      }

      await browser.close();
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
      error: "Provide ?contrib_url=.../maps/contrib/<id> or just the numeric <id>",
    });
  }
  try {
    const { url, counts } = await scrapeCounts(src);
    return res.json({
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts,
    });
  } catch (e) {
    // (Optional) capture a screenshot on failure for diagnostics
    try {
      const browser = await launchBrowser();
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.goto(src, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.screenshot({ path: "/tmp/lg_last_error.png", fullPage: true });
      await browser.close();
    } catch {}
    return res.status(422).json({ error: String(e) });
  }
});

// Row-level diagnostics — shows exactly what we read from the modal
app.get("/localguides/diag-rows", async (req, res) => {
  try {
    const src = normalizeIdOrUrl(req.query.contrib_url);
    if (!src) return res.status(400).json({ error: "Missing ?contrib_url" });

    const browser = await launchBrowser();
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });
    await page.goto(`${src}?hl=en&gl=us&authuser=0`, { waitUntil: "domcontentloaded", timeout: 90_000 });

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

    await browser.close();
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
    res.status(500).type("text/plain").send(String(e));
  }
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
