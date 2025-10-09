import puppeteer from "puppeteer";
import express from "express";
import morgan from "morgan";
import cors from "cors";

const app = express();
app.use(cors());
app.use(morgan("tiny"));

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
    /Local Guide[^]{0,120}Level\s*(\d+)/i.exec(text) ||
    /Local Guide[^]{0,120}[•·]\s*Level\s*(\d+)/i.exec(text);
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
    listsPublished: near("list[s]? published")
  };
}

async function scrapeCounts(contribUrl) {
  const chromePath =
    process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Avoid consent wall
  const cookies = [
    { name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" }
  ];
  await ctx.overridePermissions("https://www.google.com", []); // no geolocation prompts
  await page.setCookie(...cookies);

  const candidates = [
    `${contribUrl}?hl=en&gl=us`,
    `${contribUrl}/reviews?hl=en&gl=us`
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      // give it time to hydrate
      await page.waitForTimeout(1800);

      // Try to force the Contributions panel visible by small scroll
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(600);

      // Pull all text and parse
      const bodyText = (await page.evaluate(() => document.body.innerText)) || "";
      const counts = pullCountsFrom(bodyText);

      // If all zero, wait a bit more and try body text again
      if (Object.values(counts).every((n) => !n)) {
        await page.waitForTimeout(1500);
        const bodyText2 = (await page.evaluate(() => document.body.innerText)) || "";
        const counts2 = pullCountsFrom(bodyText2);
        if (!Object.values(counts2).every((n) => !n)) {
          await browser.close();
          return { url, counts: counts2, dbg: bodyText2.slice(0, 500) };
        }
      } else {
        await browser.close();
        return { url, counts, dbg: bodyText.slice(0, 500) };
      }

      lastErr = "Parsed but zeros after hydration";
    } catch (e) {
      lastErr = e;
    }
  }

  await browser.close();
  throw new Error(`Failed to parse profile: ${String(lastErr)}`);
}

app.get("/localguides/summary", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) {
    return res.status(400).json({
      error: "Provide ?contrib_url=.../maps/contrib/<id> or the numeric ID"
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

// Optional debug: shows a tiny snippet of the text we parsed
app.get("/localguides/debug", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) return res.status(400).json({ error: "Missing ?contrib_url" });
  try {
    const { url, counts, dbg } = await scrapeCounts(src);
    res.json({ triedUrl: url, counts, textSample: dbg });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
