import express from "express";
import cors from "cors";
import { geocodeLocation } from "./geocode";
import { scrapeGoogleMaps } from "./scraper";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? [process.env.FRONTEND_URL, "http://localhost:3000"]
      : "*",
    methods: ["POST", "GET"],
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/api/scrape", async (req, res) => {
  const { keyword, location } = req.body as {
    keyword?: string;
    location?: string;
  };

  if (!keyword?.trim() || !location?.trim()) {
    res.status(400).json({ error: "keyword and location are required" });
    return;
  }

  try {
    const coords = await geocodeLocation(location.trim());
    const results = await scrapeGoogleMaps(keyword.trim(), coords.lat, coords.lng);
    res.json({ results, coords });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scrape failed";
    console.error("[scrape]", message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Scraper API listening on port ${PORT}`);
});
