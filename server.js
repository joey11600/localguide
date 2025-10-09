import express from "express";
import morgan from "morgan";
import cors from "cors";
import ContributionMetadata from "google-local-guides-api";

const app = express();
app.use(cors());          // allow calls from your Base44 app
app.use(morgan("tiny"));

app.get("/localguides/summary", async (req, res) => {
  try {
    const contribUrl = String(req.query.contrib_url || "").trim();
    if (!contribUrl.includes("google.com/maps/contrib/")) {
      return res.status(400).json({ error: "Provide ?contrib_url=.../maps/contrib/<id>" });
    }
    const cg = new ContributionMetadata();
    await cg.init(contribUrl);

    const meta = cg.getMetadata?.() || {};
    const toNum = v => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, "")) || 0);

    res.json({
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
    });
  } catch (e) {
    res.status(422).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
