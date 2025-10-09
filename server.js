// server.js
// Render settings:
//   Build Command: npm install && PUPPETEER_CACHE_DIR=/opt/render/project/src/.puppeteer-cache npx puppeteer browsers install chrome --platform=linux
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

/* ---------- helpers ---------- */

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

/** Robust parser that understands the Local Guide modal labels. */
function pullCountsFrom(text) {
  // “label then number” or “number then label”, allow up to 100 chars between (handles newlines)
  const near = (label) => {
    const A = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");               // "15 Photos"
    const B = new RegExp(`(?:${label})[\\s\\S]{0,100}?(\\d[\\d,\\.]*)`, "i");  // "Photos\n15"
    const m = text.match(A) || text.match(B);
    return m ? toNum(m[1]) : 0;
  };

  // Level / points (chip & modal both show these)
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

  // Modal labels (as in your screenshot) + a couple synonyms
  const reviews       = near("reviews?");
  const ratings       = near("ratings?");
  const photos        = near("photos?");
  const videos        = near("videos?");
  const captions      = near("captions?");
  const answers       = near("answers?"); // will map to `questions`
  const edits         = near("edits?");
  const reportedWrong = near("reported\\s+incorrect");
  const factsChecked  = near("facts?\\s*checked");
  const placesAdded   = near("places?\\s+added");
  const roadsAdded    = near("roads?\\s+added");
  // Q&A sometimes appears; we don’t store it yet
  // const qa = near("Q\\s*&\\s*A|Q\\s*\\+\\s*A|Q&A");

  return {
    level,
    points,
    reviews,
    ratings,
    photos,
    edits,
    questions: answers,                              // “Answers” → questions
    facts: Math.max(reportedWrong, factsChecked),    // consolidate
    roadsAdded,
    placesAdded,
    listsPublished: 0                                // not shown in this modal
    // videos, captions // available if you decide to add to your schema later
  };
}

// Find a Chrome/Chromium binary we installed at build-time.
function findChromeBinary() {
  // manual override wins
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    try { fs.accessSync(override, fs.constants.X_OK); return override; } catch {}
  }
  // our persistent cache on Render
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
  // fallback: puppeteer’s own location
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

/* ---------- core scraping ---------- */

async function scrapeCounts(contribUrl) {
  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  // Speed + stability
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(90_000);
  page.setDefaultTimeout?.(45_000);

  // Avoid consent interstitials
  await page.setCookie({ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" });

  // Block heavy assets; keep XHR/fetch alive
  if (page.setRequestInterception) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") return req.abort();
      req.continue();
    });
  }

  // Two URL variants hydrate different shells
  const candidates = [
    `${contribUrl}?hl=en&gl=us&authuser=0`,
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`,
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

      // Try to open the “Local Guide” modal so the per-category rows render
      try {
        await page.evaluate(() => {
          const nodes = [...document.querySelectorAll('button, div[role="button"], a, div')];
          const el = nodes.find(n => /Local Guide/i.test(n.innerText || ""));
          if (el) el.click();
        });
        await sleep(800);
      } catch {}

      // Nudge hydration / lazy sections
      for (let i = 0; i < 3; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 350 * (i + 1));
        await sleep(700);
      }

      // Content-based wait (don’t rely on networkidle)
      try {
        await page.waitForFunction(
          () => {
            const t = (document.body.innerText || "").replace(/\s+/g, " ").trim();
            return (
              /Local Guide/i.test(t) ||
              /\breviews?\b/i.test(t) ||
              /\bpoints?\b/i.test(t) ||
              /\bphotos?\b/i.test(t)
            );
          },
          { timeout: 20_000, polling: 500 }
        );
      } catch {}

      // Pull visible text and parse
      let bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(bodyText)) {
        lastErr = "consent wall";
        continue;
      }

      let counts = pullCountsFrom(bodyText);

      // Late-hydrate retry
      if (Object.values(counts).every((n) => !n)) {
        await sleep(2000);
        bodyText = (await page.evaluate(() => document.body.innerText)) || "";
        counts = pullCountsFrom(bodyText);
      }

      await browser.close();
      return { url, counts };
    } catch (e) {
      lastErr = String(e);
      // try next candidate
    }
  }

  await browser.close();
  throw new Error(`Failed to parse profile (${lastErr || "unknown"})`);
}

/* ---------- routes ---------- */

app.get("/localguides/summary", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) {
    return res.status(400).json({
      error: "Provide ?contrib_url=.../maps/contrib/<id> or just the numeric <id>",
    });
  }
  try {
    const { url, counts } = await scrapeCounts(src);
    const payload = {
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts,
    };
    return res.json(payload);
  } catch (e) {
    return res.status(422).json({ error: String(e) });
  }
});

// Minimal debug routes
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

// Peek rendered text (useful once if a profile keeps returning zeros)
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
    await page.goto(`${src}?hl=en&gl=us&authuser=0`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await sleep(1200);
    // Try to open the modal for debug as well
    try {
      await page.evaluate(() => {
        const nodes = [...document.querySelectorAll('button, div[role="button"], a, div')];
        const el = nodes.find(n => /Local Guide/i.test(n.innerText || ""));
        if (el) el.click();
      });
      await sleep(600);
    } catch {}
    const text = (await page.evaluate(() => document.body.innerText)) || "";
    await browser.close();
    res.json({ sample: text.slice(0, 2000) });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

/* ---------- start ---------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
