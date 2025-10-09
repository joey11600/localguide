import express from "express";
import morgan from "morgan";
import cors from "cors";
import { chromium } from "playwright-chromium";

const app = express();
app.use(cors());
app.use(morgan("tiny"));

function normalizeIdOrUrl(raw) {
  const r = String(raw || "").trim();
  if (!r) return null;
  if (/^\d{10,}$/.test(r)) return `https://www.google.com/maps/contrib/${r}`;
  if (r.includes("google.com/maps/contrib/")) return r.replace(/\/+$/, "");
  return null;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getCountsWithBrowser(contribUrl) {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
  });
  const page = await ctx.newPage();

  // Add a consent cookie to avoid interstitials when possible
  await ctx.addCookies([
    { name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" }
  ]);

  // try main page; if needed, try /reviews
  const candidates = [
    contribUrl,
    `${contribUrl}/reviews?hl=en&gl=us`,
    `${contribUrl}?hl=en&gl=us`
  ];

  let lastErr = null;
  for (const u of candidates) {
    try {
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Wait a bit for the contribution panel to hydrate
      await page.waitForTimeout(1500);

      // Heuristics: get full text and fish out numbers around labels
      const bodyText = await page.textContent("body");
      if (!bodyText) throw new Error("Empty body text");

      const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

      const near = (label) => {
        const reA = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i");
        const reB = new RegExp(`(?:${label})[^\\d]{0,40}(\\d[\\d,\\.]*)`, "i");
        const m = bodyText.match(reA) || bodyText.match(reB);
        return m ? toNum(m[1]) : 0;
      };

      // Level often appears as "Local Guide · Level X"
      const levelMatch =
        /Local Guide[^]{0,80}Level\s*(\d+)/i.exec(bodyText) ||
        /Local Guide[^]{0,80}[•·]\s*Level\s*(\d+)/i.exec(bodyText);
      const level = levelMatch ? toNum(levelMatch[1]) : 0;

      const points =
        near("(?:points|pts)") ||
        (() => {
          const m = /(\d[\d,\.]*)\s*(?:point|pts)\b/i.exec(bodyText);
          return m ? toNum(m[1]) : 0;
        })();

      const counts = {
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

      // If everything is zero, try clicking the "Contributions" tab area (if visible)
      const allZero = Object.values(counts).every(n => !n);
      if (allZero) {
        // sometimes counts render after a tiny delay
        await page.waitForTimeout(1500);
        const bodyText2 = await page.textContent("body");
        if (bodyText2) {
          const reA = new RegExp(`(\\d[\\d,\\.]*)\\s+(?:points|pts)`, "i");
          const mm = bodyText2.match(reA);
          if (mm) counts.points = toNum(mm[1]);
        }
      }

      await browser.close();
      return { url: u, counts };
    } catch (e) {
      lastErr = e;
      // try next candidate
    }
  }

  await browser.close();
  const err = new Error(`Failed to render profile (${String(lastErr)})`);
  err.code = "RENDER_FAIL";
  throw err;
}

app.get("/localguides/summary", async (req, res) => {
  const src = normalizeIdOrUrl(req.query.contrib_url);
  if (!src) return res.status(400).json({ error: "Provide ?contrib_url=.../maps/contrib/<id> or the numeric ID" });

  try {
    const { url, counts } = await getCountsWithBrowser(src);
    return res.json({
      contribUrl: url,
      fetchedAt: new Date().toISOString(),
      ...counts
    });
  } catch (e) {
    return res.status(422).json({ error: String(e) });
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
