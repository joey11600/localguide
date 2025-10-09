import express from "express";
import morgan from "morgan";
import cors from "cors";
import ContributionMetadata from "google-local-guides-api";

// --- SAFETY PATCH: make the library's regex matcher null-safe
const _origGetMatch = ContributionMetadata.prototype.getMatch;
ContributionMetadata.prototype.getMatch = function (pattern, text) {
  try {
    const matches = String(text || "").match(pattern);
    return matches && matches[1] ? matches[1] : "";
  } catch {
    return "";
  }
};

const app = express();
app.use(cors());          // allow Base44
app.use(morgan("tiny"));

function buildVariants(raw) {
  const base = String(raw).trim().replace(/\/+$/, "");
  const u0 = base.includes("google.com/maps/contrib/")
    ? base
    : `https://www.google.com/maps/contrib/${base}`;

  const addLocale = (u) => (u.includes("?") ? `${u}&hl=en&gl=us` : `${u}?hl=en&gl=us`);
  return [
    u0,
    `${u0}/reviews`,
    addLocale(u0),
    addLocale(`${u0}/reviews`)
  ];
}

async function fetchMeta(contribUrl) {
  const cg = new ContributionMetadata();
  await cg.init(contribUrl);  // library loads the page and parses

  // library sometimes returns strings; normalize
  const meta = (cg.getMetadata && cg.getMetadata()) || {};
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
      return res.json(data);
    } catch (e) {
      lastErr = e;
    }
  }

  return res.status(422).json({
    error: `Failed to parse Local Guides profile. Could be private/empty, consent/locale wall, or a markup change. Last error: ${String(lastErr)}`
  });
});

// health check (optional)
app.get("/", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
