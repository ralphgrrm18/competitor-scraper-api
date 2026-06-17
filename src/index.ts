import express from "express";
import cors from "cors";
import { geocodeLocation } from "./geocode";
import { scrapeGoogleMaps, ScrapeMode } from "./scraper";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());
app.use(cors({ origin: "*", methods: ["POST", "GET"] }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post("/api/scrape", async (req, res) => {
  const { keyword, location, lat, lng, mode } = req.body as {
    keyword?: string;
    location?: string;
    lat?: number | string;
    lng?: number | string;
    mode?: ScrapeMode;
  };

  if (!keyword?.trim()) {
    res.status(400).json({ error: "keyword is required" });
    return;
  }

  const hasManualCoords =
    lat !== undefined && lng !== undefined && lat !== "" && lng !== "";

  if (!hasManualCoords && !location?.trim()) {
    res.status(400).json({ error: "provide either location or lat/lng coordinates" });
    return;
  }

  try {
    let coords: { lat: number; lng: number; displayName: string };

    if (hasManualCoords) {
      const parsedLat = parseFloat(String(lat));
      const parsedLng = parseFloat(String(lng));
      if (isNaN(parsedLat) || isNaN(parsedLng)) {
        res.status(400).json({ error: "lat and lng must be valid numbers" });
        return;
      }
      coords = { lat: parsedLat, lng: parsedLng, displayName: `${parsedLat}, ${parsedLng}` };
    } else {
      coords = await geocodeLocation(location!.trim());
    }

    const scrapeMode: ScrapeMode = mode === "search" ? "search" : "maps";
    const results = await scrapeGoogleMaps(keyword.trim(), coords.lat, coords.lng, {
      mode: scrapeMode,
      location: location?.trim(),
    });
    res.json({ results, coords, mode: scrapeMode });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scrape failed";
    console.error("[scrape]", message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Scraper API listening on port ${PORT}`);
});
