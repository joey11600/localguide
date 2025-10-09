import express from "express";
import morgan from "morgan";
import cors from "cors";
import ContributionMetadata from "google-local-guides-api";

const app = express();
app.use(cors());          // allow Base44
app.use(morgan("tiny"));

function buildVariants(raw) {
  // Ensure it's a contrib URL
  const base = raw.replace(/\/+$/, "");
  const u0 = base.includes("google.com/maps/contrib/")
    ? base
    : `https://www.google.com/maps/contrib/${raw}`;

  // Add locale params to dodge consent/localization pages
  const addLocale = (u) => (u.includes("?") ? `${u}&hl=en&gl=us` : `${u}?hl=en&gl=us`);

  // Try plain, /reviews, and both with locale params
  const v = [];
  v.push(u0);
  v.push(`${u0}/reviews`);
  v.push(addLocale(u0));
  v.push(addLocale(`${u0}/reviews`));
  return v;
}

async function fetchMeta(contribUrl) {
  const cg = new ContributionMetadata();
  await cg.init(contribUrl);               // might throw if the page layout is unexpected
  const meta = cg.getMetadata?.() || {};
  const toNum = (v) => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);
  return {
    contribUrl,
    fetchedAt: new Date().toISOString(),
    level: toNum(cg.getLevel?.() ?? meta.level),
    points: toNum(cg.getPoints?.() ?? meta.points),
    reviews: toNum(meta.reviews),
    ratings: toNum(meta.ratings),
    photos: toNum(meta.photos ?? meta.videos),
    edits: toNum(meta.edits),
    questions: toNum(meta.questions),
    facts: toNum(meta.facts),
    roadsAdded: toNum(meta.roadsAdded),
    placesAdded: toNum(meta.placesAdded),
    listsPublished: toNum(meta.listsPublished)
  };
}

app.get("/localguides/summary", async (req, res) => {
  try {
    const raw = String(req.query.contrib_url || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing ?contrib_url" });
    if (!raw.includes("google.com/maps/contrib/") && !/^\d{10,}$/.test(raw)) {
      return res.status(400).json({ error: "Provide a full Maps contrib URL or numeric ID" });
    }

    const variants = buildVariants(raw);
    let lastErr = null;

    for (const u of variants) {
      try {
        const data = await fetchMeta(u);
        // sanity: if level/points are both 0 and everything else 0, it could be a private profile
        return res.json(data);
      } catch (e) {
        lastErr = e;
      }
    }

    // Could be private/empty or Google changed markup
    return res.status(422).json({
      error: `Failed to parse Local Guides profile. Possible causes: private/empty profile, consent/locale page, or markup change. Last error: ${String(lastErr)}`
    });
  } catch (err) {
    return res.status(422).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
