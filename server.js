const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const ContributionMetadata = require('google-local-guides-api');

const app = express();
app.use(cors());
app.use(morgan('tiny'));

// null-safe shim so the library can't crash on unexpected markup
const origGetMatch = ContributionMetadata.prototype.getMatch;
ContributionMetadata.prototype.getMatch = function (pattern, text) {
  try {
    const m = String(text || '').match(pattern);
    return (m && m[1]) ? m[1] : '';
  } catch { return ''; }
};

function variants(raw) {
  const base = String(raw).trim().replace(/\/+$/, '');
  const u0 = base.includes('google.com/maps/contrib/') ? base : `https://www.google.com/maps/contrib/${base}`;
  const addLocale = u => (u.includes('?') ? `${u}&hl=en&gl=us` : `${u}?hl=en&gl=us`);
  return [u0, `${u0}/reviews`, addLocale(u0), addLocale(`${u0}/reviews`)];
}

app.get('/localguides/summary', async (req, res) => {
  const raw = String(req.query.contrib_url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing ?contrib_url' });

  let lastErr = null;
  for (const url of variants(raw)) {
    try {
      const cm = new ContributionMetadata();
      await cm.init(url);
      const meta = cm.getMetadata?.() || {};
      const num = v => (v == null ? 0 : Number(String(v).replace(/[^\d]/g, '')) || 0);
      return res.json({
        contribUrl: url,
        fetchedAt: new Date().toISOString(),
        level: num(cm.getLevel?.() ?? meta.level),
        points: num(cm.getPoints?.() ?? meta.points),
        reviews: num(meta.reviews),
        ratings: num(meta.ratings),
        photos: num(meta.photos ?? meta.videos),
        edits: num(meta.edits),
        questions: num(meta.questions),
        facts: num(meta.facts),
        roadsAdded: num(meta.roadsAdded),
        placesAdded: num(meta.placesAdded),
        listsPublished: num(meta.listsPublished)
      });
    } catch (e) { lastErr = e; }
  }
  res.status(422).json({ error: `Library couldn't parse this profile (private/consent wall/markup change). Last error: ${String(lastErr)}` });
});

app.get('/', (_req, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LG wrapper listening on :${PORT}`));
