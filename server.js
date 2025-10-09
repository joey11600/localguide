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

/** Text parser — mainly for Level & Points, and fallback */
function pullCountsFrom(text) {
  const near = (label) => {
    const A = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
    const B = new RegExp(`(?:${label})[\\s\\S]{0,120}?(\\d[\\d,\\.]*)`, "i");
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
      "--no-default-browser-check"
    ]
  });
}

/* --------------- modal open + deep (shadow DOM) extract --------------- */

/** Click the points chip to open the stats modal. */
async function openStatsModal(page) {
  // click the chip by jsaction/class
  const sel = '[jsaction*="pane.profile-stats.showStats"], .uyVA9';
  const exists = await page.$(sel);
  if (exists) {
    await page.click(sel).catch(() => {});
  } else {
    // Fallback: click any element with "points" in its text
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button,[role="button"],a,div,span')];
      const el = nodes.find(n => /points/i.test(n.textContent || ""));
      if (el) el.click();
    });
  }
  // wait for something that looks like the modal to appear
  try {
    await page.waitForFunction(
      () => !!document.querySelector('.QrGqBf') ||
            !!document.querySelector('[role="dialog"]') ||
            !!document.querySelector('div[aria-modal="true"]'),
      { timeout: 7000 }
    );
    return true;
  } catch {
    return false;
  }
}

/** Recursively traverse shadow DOM to find rows and extract label/value. */
async function extractCountsFromModal(page) {
  return await page.evaluate(() => {
    const toNum = v => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

    function* walk(root) {
      yield root;
      const els = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of els) {
        yield el;
        if (el.shadowRoot) {
          yield* walk(el.shadowRoot);
        }
      }
    }

    // Collect row containers that have either of the class tokens we saw
    const rows = [];
    for (const node of walk(document)) {
      const cls = (node.className || "").toString();
      if (/\bnKYSz\b/.test(cls)) rows.push(node);
      // Some builds wrap rows without nKYSz; catch label/value pairs too
    }

    // Helper: find first match under a root, searching into shadow DOM too
    function findTextDeep(root, selector) {
      // direct
      const direct = root.querySelector?.(selector);
      if (direct) return (direct.textContent || "").trim();
      // deep
      for (const el of root.querySelectorAll?.("*") || []) {
        if (el.matches?.(selector)) return (el.textContent || "").trim();
        if (el.shadowRoot) {
          const t = findTextDeep(el.shadowRoot, selector);
          if (t) return t;
        }
      }
      return "";
    }

    const out = {
      reviews: 0, ratings: 0, photos: 0, edits: 0, questions: 0, facts: 0,
      roadsAdded: 0, placesAdded: 0, listsPublished: 0
    };

    // Primary: rows with clear label/value spans
    for (const r of rows) {
      const label = (findTextDeep(r, ".FM5HI") || "").toLowerCase();
      const value = toNum(findTextDeep(r, ".AyEQdd") || "0");
      switch (label) {
        case "reviews": out.reviews = value; break;
        case "ratings": out.ratings = value; break;
        case "photos": out.photos = value; break;
        case "videos": /* ignore */ break;
        case "captions": /* ignore */ break;
        case "answers": out.questions = value; break;
        case "edits": out.edits = value; break;
        case "reported incorrect": out.facts = Math.max(out.facts, value); break;
        case "facts checked": out.facts = Math.max(out.facts, value); break;
        case "places added": out.placesAdded = value; break;
        case "roads added": out.roadsAdded = value; break;
        case "q&a": /* ignore */ break;
      }
    }

    // Fallback: if we didn’t find rows, scan all text for pairs seen in modal
    if (
      !out.reviews && !out.photos && !out.edits && !out.questions &&
      !out.facts && !out.placesAdded && !out.roadsAdded && !out.ratings
    ) {
      const dense = (document.body.innerText || "").replace(/\s+/g, " ");
      function near(label) {
        const A = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
        const B = new RegExp(`(?:${label})\\s*(\\d[\\d,\\.]*)`, "i");
        const m = dense.match(A) || dense.match(B);
        return m ? toNum(m[1]) : 0;
      }
      out.reviews     = near("Reviews?");
      out.ratings     = near("Ratings?");
      out.photos      = near("Photos?");
      out.edits       = near("Edits?");
      out.questions   = near("Answers?");
      out.facts       = Math.max(near("Reported\\s+incorrect"), near("Facts?\\s*checked"));
      out.placesAdded = near("Places\\s+added");
      out.roadsAdded  = near("Roads\\s+added");
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

  // Block heavy assets (allow CSS so layout stays sane)
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
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

      // open the Local Guide stats modal
      await openStatsModal(page);
      // hydrate a bit
      for (let i = 0; i < 2; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 400 * (i + 1));
        await sleep(600);
      }

      // DOM-first extraction from modal rows (with deep shadow traversal)
      const domCounts = await extractCountsFromModal(page);

      // Always parse text for Level/Points (+ safety fallback)
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

// Debug helpers
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
