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

function normalizeIdOrUrl(raw) {
  const r = String(raw || "").trim();
  if (!r) return null;
  if (/^\d{10,}$/.test(r)) return `https://www.google.com/maps/contrib/${r}`;
  if (r.includes("google.com/maps/contrib/")) return r.replace(/\/+$/, "");
  return null;
}

const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

function pullCountsFrom(text) {
  const near = (label) => {
    const reA = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
    const reB = new RegExp(`(?:${label})[^\\d]{0,60}(\\d[\\d,\\.]*)`, "i");
    const m = text.match(reA) || text.match(reB);
    return m ? toNum(m[1]) : 0;
  };

  const levelMatch =
    /Local Guide[^]{0,200}Level\s*(\d+)/i.exec(text) ||
    /Local Guide[^]{0,200}[•·]\s*Level\s*(\d+)/i.exec(text);
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
    reviews: near("review[s]?"),
    ratings: near("rating[s]?"),
    photos: near("photo[s]?|video[s]?"),
    edits: near("edit[s]?"),
    questions: near("question[s]?"),
    facts: near("fact[s]?"),
    roadsAdded: near("road[s]? added"),
    placesAdded: near("place[s]? added"),
    listsPublished: near("list[s]? published"),
  };
}

// Recursively find a Chrome/Chromium binary under the cache dir or puppeteer path.
function findChromeBinary() {
  // 1) Manual override if provided
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    try {
      fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch {}
  }

  // 2) Our project-persistent cache on Render
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
          try {
            fs.accessSync(p, fs.constants.X_OK);
            return p;
          } catch {}
        }
      }
    }
  }

  // 3) Puppeteer’s own download location (node_modules cache)
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();

  // Speed + stability
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  page.setDefaultNavigationTimeout?.(90_000);
  page.setDefaultTimeout?.(45_000);

  // Avoid consent interstitials (set cookie on the page)
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

  const candidates = [
    `${contribUrl}?hl=en&gl=us&authuser=0`,
    `${contribUrl}/reviews?hl=en&gl=us&authuser=0`,
  ];

  const parseText = (text) => {
    const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
    const near = (label) => {
      const A = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
      const B = new RegExp(`(?:${label})[^\\d]{0,80}(\\d[\\d,\\.]*)`, "i");
      const m = text.match(A) || text.match(B);
      return m ? toNum(m[1]) : 0;
    };
    const levelMatch =
      /Local Guide[^]{0,220}Level\s*(\d+)/i.exec(text) ||
      /Local Guide[^]{0,220}[•·]\s*Level\s*(\d+)/i.exec(text);
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
      reviews: near("review[s]?"),
      ratings: near("rating[s]?"),
      photos: near("photo[s]?|video[s]?"),
      edits: near("edit[s]?"),
      questions: near("question[s]?"),
      facts: near("fact[s]?"),
      roadsAdded: near("road[s]? added"),
      placesAdded: near("place[s]? added"),
      listsPublished: near("list[s]? published"),
    };
  };

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

      // Nudge hydration/lazy sections
      for (let i = 0; i < 3; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), 350 * (i + 1));
        await sleep(700);
      }

      // Content-based wait (don’t rely on networkidle)
      try {
        await page.waitForFunction(
          () => {
            const t = (document.body.innerText || "").replace(/\s+/g, " ").trim();
            return /Local Guide/i.test(t) || /\breviews?\b/i.test(t) || /\bpoints?\b/i.test(t);
          },
          { timeout: 20_000, polling: 500 }
        );
      } catch {
        // carry on; we’ll parse whatever we have
      }

      let bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(bodyText)) {
        lastErr = "consent wall";
        continue;
      }

      let counts = parseText(bodyText);

      // Late hydrate retry
      if (Object.values(counts).every((n) => !n)) {
        await sleep(2000);
        bodyText = (await page.evaluate(() => document.body.innerText)) || "";
        counts = parseText(bodyText);
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
    return res.json({
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts,
    });
  } catch (e) {
    return res.status(422).json({ error: String(e) });
  }
});

// Minimal debug routes (useful once, then you can remove)
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

// Rendered-text peek to tune regexes if needed
app.get("/localguides/debug", async (req, res) => {
  try {
    const src = normalizeIdOrUrl(req.query.contrib_url);
    if (!src) return res.status(400).json({ error: "Missing ?contrib_url" });
    const browser = await launchBrowser();
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setCookie({
      name: "CONSENT",
      value: "YES+cb",
      domain: ".google.com",
      path: "/",
    });
    const url = `${src}?hl=en&gl=us`;
    await page.goto(url, { waitUntil: "networkidle0", timeout: 45000 });
    await page.waitForTimeout(1200);
    const text = (await page.evaluate(() => document.body.innerText)) || "";
    await browser.close();
    res.json({ url, sample: text.slice(0, 2000) });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

/* ---------- start ---------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
