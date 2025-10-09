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
    const reB = new RegExp(`(?:${label})[^\\d]{0,40}(\\d[\\d,\\.]*)`, "i");
    const m = text.match(reA) || text.match(reB);
    return m ? toNum(m[1]) : 0;
  };

  const levelMatch =
    /Local Guide[^]{0,160}Level\s*(\d+)/i.exec(text) ||
    /Local Guide[^]{0,160}[•·]\s*Level\s*(\d+)/i.exec(text);
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

/** Search for a Chrome/Chromium binary installed during build. */
function findChromeBinary() {
  // 1) Respect manual override if present
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    try {
      fs.accessSync(process.env.PUPPETEER_EXECUTABLE_PATH, fs.constants.X_OK);
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    } catch {}
  }

  // 2) Project-persistent cache (recommended)
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
      "Chrome/Chromium not found. Ensure your build installs a browser (e.g., postinstall: `npx puppeteer install chrome`)."
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

async function scrapeCounts(contribUrl) {
  const browser = await launchBrowser();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Avoid consent interstitials
  await ctx.addCookies([{ name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" }]);

  const candidates = [
    `${contribUrl}?hl=en&gl=us`,
    `${contribUrl}/reviews?hl=en&gl=us`,
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Let the page hydrate; nudge scroll to trigger lazy bits.
      await page.waitForTimeout(1800);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(800);

      // Quick consent-wall check
      const bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      if (/Before you continue to Google/i.test(bodyText)) {
        lastErr = "consent wall";
        continue;
      }

      let counts = pullCountsFrom(bodyText);

      // If all zeros, wait a bit and try again
      if (Object.values(counts).every((n) => !n)) {
        await page.waitForTimeout(1500);
        const bodyText2 = (await page.evaluate(() => document.body.innerText)) || "";
        counts = pullCountsFrom(bodyText2);
      }

      await browser.close();
      return { url, counts };
    } catch (e) {
      lastErr = String(e);
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

// Minimal debug: show where we think Chrome lives (no secrets leaked)
app.get("/__whoami", (_req, res) => {
  res.json({
    node: process.version,
    execPathTried: findChromeBinary(),
    cacheDirExists: fs.existsSync("/opt/render/project/src/.puppeteer-cache"),
  });
});

// (Optional) quick peek at cache tree head for troubleshooting
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

app.get("/", (_req, res) => res.status(200).send("OK"));

/* ---------- start ---------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
