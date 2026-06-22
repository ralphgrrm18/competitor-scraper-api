import { chromium, BrowserContext } from "playwright";

export interface ScrapedBusiness {
  rank: number;
  name: string;
  address: string;
  rating: number | null;
  reviewCount: number | null;
  category: string;
  phone: string | null;
  website: string | null;
  openNow: boolean | null;
  weekdayHours: string[];
  todayHours: string | null;
  mapsUrl: string;
  photoCount: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type ScrapeMode = "maps" | "search";

// ─── SerpAPI types ───────────────────────────────────────────────────────────

interface SerpLocalPlace {
  position?: number;
  title?: string;
  place_id?: string;
  rating?: number;
  reviews?: number;
  type?: string;
  address?: string;
  phone?: string;
  hours?: string | { current_status?: string };
  links?: { website?: string };
  website?: string;
}

interface SerpResponse {
  local_results?: SerpLocalPlace[];
  error?: string;
}

// ─── SerpAPI: Google Search local results ────────────────────────────────────
// Called for mode="search". No browser needed — results come back in <2s.
// Uses google_local engine which mirrors the Google Search local tab.
// Supports either a location string or raw lat/lng coordinates.

async function scrapeViaSerp(
  keyword: string,
  lat: number,
  lng: number,
  location?: string
): Promise<ScrapedBusiness[]> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SERPAPI_API_KEY is not set. Add it to Railway → Variables."
    );
  }

  const q = location ? `${keyword} ${location}` : keyword;
  const ll = `@${lat},${lng},14z`;
  const params = new URLSearchParams({
    engine: "google_local",
    q,
    ll,
    hl: "en",
    gl: "us",
    num: "10",
    api_key: apiKey,
  });

  console.log(`[serp] engine=google_local q="${q}" ll="${ll}"`);

  const res = await fetch(`https://serpapi.com/search?${params}`);
  const data = (await res.json()) as SerpResponse;

  if (data.error) {
    if (/out of searches|quota|limit|upgrade/i.test(data.error)) {
      throw new Error(
        "Google Search quota reached for this month. Switch to Google Maps mode to continue."
      );
    }
    throw new Error(`SerpAPI: ${data.error}`);
  }

  if (!res.ok) throw new Error(`SerpAPI returned HTTP ${res.status}`);

  const places = data.local_results ?? [];
  console.log(`[serp] got ${places.length} local results`);

  return places.slice(0, 10).map((p, i): ScrapedBusiness => {
    const hoursRaw = typeof p.hours === "string" ? p.hours : (p.hours?.current_status ?? "");
    const openNow = /open now|open 24/i.test(hoursRaw)
      ? true
      : /closed|closes/i.test(hoursRaw)
      ? false
      : null;

    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const today = days[new Date().getDay()];
    const todayHours = hoursRaw ? `${today} · ${hoursRaw}` : null;

    return {
      rank: p.position ?? i + 1,
      name: p.title ?? "",
      address: p.address ?? "",
      rating: p.rating ?? null,
      reviewCount: p.reviews ?? null,
      category: p.type ?? "",
      phone: p.phone ?? null,
      website: p.links?.website ?? p.website ?? null,
      openNow,
      weekdayHours: [],
      todayHours,
      mapsUrl: p.place_id
        ? `https://www.google.com/maps/place/?q=place_id:${p.place_id}`
        : "",
      photoCount: 0,
    };
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function scrapeGoogleMaps(
  keyword: string,
  lat: number,
  lng: number,
  options: { mode?: ScrapeMode; location?: string } = {}
): Promise<ScrapedBusiness[]> {
  const mode = options.mode ?? "maps";

  // Search mode: SerpAPI handles everything — no browser launched
  if (mode === "search") {
    return scrapeViaSerp(keyword, lat, lng, options.location);
  }

  // Maps mode: Playwright + geolocation spoofing
  // Extracts all data from the list page only — no detail page visits.
  // This keeps memory usage low enough for Render's 512MB free tier.
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--no-first-run",
      "--mute-audio",
      "--no-zygote",
      "--single-process",
      "--disable-software-rasterizer",
      "--js-flags=--max-old-space-size=128",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
    ],
  });

  try {
    const context = await browser.newContext({
      geolocation: { latitude: lat, longitude: lng },
      permissions: ["geolocation"],
      userAgent: USER_AGENT,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 800, height: 600 },
    });

    await context.route(/\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|mp4|mp3|ogg|wasm)(\?.*)?$/, (r) =>
      r.abort()
    );
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "media" || type === "stylesheet") route.abort();
      else route.continue();
    });

    console.log(`[scrape] mode=maps keyword="${keyword}" at ${lat},${lng}`);
    const results = await scrapeListPage(context, keyword, lat, lng);
    console.log(`[scrape] done — ${results.length} results from list page`);
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapeListPage(
  context: BrowserContext,
  keyword: string,
  lat: number,
  lng: number
): Promise<ScrapedBusiness[]> {
  const page = await context.newPage();

  try {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${lat},${lng},14z?hl=en`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsentBanner(page);
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });

    // Scroll to load more cards
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop += 1500;
      });
      await delay(700);
    }

    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const today = days[new Date().getDay()];

    const businesses = await page.evaluate((todayName: string) => {
      const cards = Array.from(document.querySelectorAll('.Nv2PK'));
      const seen = new Set<string>();
      const businesses: ScrapedBusiness[] = [];

      for (const card of cards) {
        const anchor = card.querySelector('a.hfpxzc') as HTMLAnchorElement | null;
        const mapsUrl = anchor?.href ?? "";
        if (!mapsUrl || seen.has(mapsUrl)) continue;
        seen.add(mapsUrl);

        const name = (card.querySelector('.qBF1Pd') as HTMLElement)?.innerText?.trim() ?? "";
        if (!name) continue;

        const ratingRaw = (card.querySelector('.MW4etd') as HTMLElement)?.innerText?.trim();
        const rating = ratingRaw ? parseFloat(ratingRaw.replace(",", ".")) : null;

        const reviewRaw = (card.querySelector('.UY7F9') as HTMLElement)?.innerText?.trim() ?? "";
        const reviewMatch = reviewRaw.match(/([\d,]+)/);
        const reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, "")) : null;

        // The info block contains "Category · Address · Open/Closed · Phone" separated by ·
        const infoEl = card.querySelector('.W4Efsd') as HTMLElement | null;
        const infoText = infoEl?.innerText?.trim() ?? "";
        const parts = infoText.split(/[·\n]/).map(s => s.trim()).filter(Boolean);

        // Category is first part (no digits usually), address has digits or street keywords
        const category = parts.find(p => !/^\d/.test(p) && !/^[(+]/.test(p) && !/open|close/i.test(p)) ?? "";
        const address = parts.find(p => /\d/.test(p) && !/^[(+\d].*\d{4}/.test(p) && !/open|close/i.test(p)) ?? "";

        const fullText = card.textContent ?? "";
        const openNow = /open now|open 24/i.test(fullText)
          ? true
          : /\bclosed\b/i.test(fullText)
          ? false
          : null;

        const hoursMatch = fullText.match(/closes?\s+\d+\s*[ap]m|open\s+24\s+hours|open\s+now/i);
        const todayHours = hoursMatch ? `${todayName} · ${hoursMatch[0].trim()}` : null;

        const websiteEl = (
          card.querySelector('a[data-item-id="authority"]') ??
          card.querySelector('a[aria-label*="website" i]') ??
          Array.from(card.querySelectorAll('a[href]')).find(
            (a) => (a as HTMLAnchorElement).href.startsWith('http') && !(a as HTMLAnchorElement).href.includes('google.com')
          )
        ) as HTMLAnchorElement | null;
        const website = websiteEl?.href ?? null;

        businesses.push({
          rank: businesses.length + 1,
          name,
          address,
          rating,
          reviewCount,
          category,
          phone: null,
          website,
          openNow,
          weekdayHours: [],
          todayHours,
          mapsUrl,
          photoCount: 0,
        });

        if (businesses.length >= 10) break;
      }

      return businesses;
    }, today) as ScrapedBusiness[];

    return businesses;
  } finally {
    await page.close();
  }
}

async function dismissConsentBanner(page: Awaited<ReturnType<BrowserContext["newPage"]>>): Promise<void> {
  const selectors = [
    'button[aria-label="Accept all"]',
    'button:has-text("Accept all")',
    'button:has-text("Reject all")',
    "#L2AGLb",
  ];
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout: 2500 });
      return;
    } catch {}
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
