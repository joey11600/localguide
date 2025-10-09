import express from "express";
import morgan from "morgan";
import cors from "cors";

// Use a desktop-ish user agent to avoid lightweight shells
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

const app = express();
app.use(cors());
app.use(morgan("tiny"));

// ------- helpers
function buildVariants(raw) {
  const base = String(raw).trim().replace(/\/+$/, "");
  const u0 = base.includes("google.com/maps/contrib/")
    ? base
    : `https://www.google.com/maps/contrib/${base}`;
  const addLocale = (u) => (u.includes("?") ? `${u}&hl=en&gl=us` : `${u}?hl=en&gl=us`);
  return [u0, `${u0}/reviews`, addLocale(u0), addLocale(`${u0}/reviews`)];
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BASE_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
  const text = await res.text();
  return { finalUrl: res.url || url, html: text };
}

const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

// crude-but-robust text scraping with multiple fallbacks
function parseCounts(html) {
  const find = (label) => {
    let m =
      new RegExp(`(\\d[\\d,\\.]*)\\s+(?:${label})`, "i").exec(html) ||
      new RegExp(`(?:${label})[^\\d]{0,40}(\\d[\\d,\\.]*)`, "i").exec(html);
    return m ? toNum(m[1]) : 0;
  };

  // "Local Guide • Level X" patterns
  let levelMatch =
    /Local Guide[^<]{0,60}Level\s*(\d+)/i.exec(html) ||
    /Local Guide[^<]{0,60}[•·]\s*Level\s*(\d+)/i.exec(html);
  const level = levelMatch ? toNum(levelMatch[1]) : 0;

  const points =
    find("(?:points|pts)") ||
    (() => {
      const m = /(\d[\d,\.]*)\s*(?:point|pts)\b/i.exec(html);
      return m ? toNum(m[1]) : 0;
    })();

  const reviews = find("review[s]?");
  const ratings = find("rating[s]?");
  const photos = find("photo[s]?|video[s]?");
  const edits = find("edit[s]?");
  const questions = find("question[s]?");
  const facts = find("fact[s]?");
  const roadsAdded = find("road[s]? added");
  const placesAdded = find("place[s]? added");
  const listsPublished = find("list[s]? published");

  return { level, points, reviews, ratings, photos, edits, questions, facts, roadsAdded, placesAdded, listsPublished };
}

// ------- endpoints

// Main summary endpoint Base44 will call
app.get("/localguides/summary", async (req, res) => {
  const raw = String(req.query.contrib_url || "").trim();
  if (!raw) return res.status(400).json({ error: "Missing ?contrib_url" });
  if (!raw.includes("google.com/maps/contrib/") && !/^\d{10,}$/.test(raw)) {
    return res.status(400).json({ error: "Provide a full Maps contrib URL or numeric ID" });
  }

  const variants = buildVariants(raw);
  let lastErr = null;

  for (const u of variants) {
    try {
      const { finalUrl, html } = await fetchHtml(u);

      // skip consent pages
      if (/Before you continue to Google/i.test(html) || /consent/i.test(html)) {
        lastErr = "Hit consent page";
        continue;
      }

      const counts = parseCounts(html);
      const allZero = Object.values(counts).every((n) => !n);

      // log a tiny snippet for debugging in Render Logs
      console.log("[LG] URL:", finalUrl);
      console.log("[LG] Counts:", counts);
      console.log("[LG] Snippet:", html.slice(0, 200).replace(/\s+/g, " "));

      if (!allZero) {
        return res.json({ contribUrl: finalUrl, fetchedAt: new Date().toISOString(), ...counts });
      }
      lastErr = "Parsed but all zeros";
    } catch (e) {
      lastErr = String(e);
    }
  }

  return res.status(422).json({
    error:
      "Could not parse profile (private/empty/consent wall or markup change). " +
      `Last note: ${lastErr}`
  });
});

// Debug endpoint so we can see what HTML you actually receive
app.get("/localguides/debug", async (req, res) => {
  const raw = String(req.query.contrib_url || "").trim();
  if (!raw) return res.status(400).json({ error: "Missing ?contrib_url" });

  const variants = buildVariants(raw);
  for (const u of variants) {
    try {
      const { finalUrl, html } = await fetchHtml(u);
      return res.json({
        triedUrl: u,
        finalUrl,
        htmlSample: html.slice(0, 4000) // first 4k chars is enough to tune
      });
    } catch (e) {
      // try next variant
    }
  }
  return res.status(422).json({ error: "Failed to fetch any variant" });
});

app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
