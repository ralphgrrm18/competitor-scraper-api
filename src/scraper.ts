import { chromium, BrowserContext, Page } from "playwright";

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
    ],
  });

  try {
    const context = await browser.newContext({
      geolocation: { latitude: lat, longitude: lng },
      permissions: ["geolocation"],
      userAgent: USER_AGENT,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 900 },
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
    const placeLinks = await getPlaceLinks(context, keyword, lat, lng);
    console.log(`[scrape] found ${placeLinks.length} place links`);

    if (!placeLinks.length) return [];

    const CONCURRENCY = 3;
    const ordered: (ScrapedBusiness | null)[] = new Array(placeLinks.length).fill(null);
    const executing = new Set<Promise<void>>();

    for (let i = 0; i < placeLinks.length; i++) {
      const idx = i;
      console.log(`[scrape] queuing rank ${idx + 1}/${placeLinks.length}`);
      const p: Promise<void> = scrapePlaceDetail(context, placeLinks[idx], idx + 1)
        .then((r) => { ordered[idx] = r; })
        .finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= CONCURRENCY) await Promise.race(executing);
    }
    await Promise.all(executing);

    // Retry any crashed/timed-out pages sequentially
    const toRetry = placeLinks
      .map((link, i) => ({ link, i }))
      .filter(({ i }) => ordered[i] === null);
    if (toRetry.length > 0) {
      console.log(`[scrape] retrying ${toRetry.length} failed page(s) sequentially`);
      for (const { link, i } of toRetry) {
        ordered[i] = await scrapePlaceDetail(context, link, i + 1);
      }
    }

    const results = ordered.filter((r): r is ScrapedBusiness => r !== null);
    console.log(`[scrape] done — ${results.length}/${placeLinks.length} succeeded`);
    return results;
  } finally {
    await browser.close();
  }
}

async function getPlaceLinks(
  context: BrowserContext,
  keyword: string,
  lat: number,
  lng: number
): Promise<string[]> {
  const page = await context.newPage();

  try {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${lat},${lng},14z?hl=en`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    await dismissConsentBanner(page);

    // Wait for the results feed
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });

    // Scroll the feed to load more results — keep scrolling until 20 links found or feed stops growing
    let prevCount = 0;
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop += 1500;
      });
      await delay(1000);

      const count = await page.$$eval(
        '[role="feed"] a[href*="/maps/place/"]',
        (anchors) => new Set((anchors as HTMLAnchorElement[]).map((a) => a.href)).size
      );
      if (count >= 10) break;
      if (count === prevCount && i > 3) break; // feed stopped growing
      prevCount = count;
    }

    const links: string[] = await page.$$eval(
      '[role="feed"] a[href*="/maps/place/"]',
      (anchors) => {
        const seen = new Set<string>();
        return (anchors as HTMLAnchorElement[])
          .map((a) => a.href)
          .filter((href) => {
            if (!href || seen.has(href)) return false;
            seen.add(href);
            return true;
          });
      }
    );

    return links.slice(0, 10);
  } finally {
    await page.close();
  }
}


async function scrapePlaceDetail(
  context: BrowserContext,
  url: string,
  rank: number
): Promise<ScrapedBusiness | null> {
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await dismissConsentBanner(page);

    await page.waitForSelector("h1", { timeout: 10000 });

    const data = await page.evaluate((): Omit<ScrapedBusiness, "rank" | "mapsUrl" | "todayHours"> => {
      function text(sel: string): string {
        return document.querySelector(sel)?.textContent?.trim() ?? "";
      }

      // --- Name ---
      const name =
        (document.querySelector("h1.DUwDvf") as HTMLElement)?.innerText?.trim() ||
        (document.querySelector("h1") as HTMLElement)?.innerText?.trim() ||
        "";

      // --- Rating ---
      const ratingEl =
        document.querySelector('div.F7nice span[aria-hidden="true"]') ||
        document.querySelector('[data-attrid="kc:/collection/knowledge_panels/has_feature_interest:star_score"] span[aria-hidden]');
      const ratingRaw = ratingEl?.textContent?.trim().replace(",", ".");
      const rating = ratingRaw ? parseFloat(ratingRaw) : null;

      // --- Review count ---
      // Strategy 1: any element whose aria-label explicitly says "N reviews"
      let reviewCount: number | null = null;
      const allLabelled = Array.from(document.querySelectorAll("[aria-label]"));
      for (const el of allLabelled) {
        const label = el.getAttribute("aria-label") ?? "";
        const m = label.match(/^([\d,]+)\s*review/i);
        if (m) { reviewCount = parseInt(m[1].replace(/,/g, "")); break; }
      }
      // Strategy 2: parenthesized number inside the rating block e.g. "(1,234)"
      if (reviewCount === null) {
        const ratingBlock = document.querySelector("div.F7nice, [jsaction*='review']");
        const parenMatch = ratingBlock?.textContent?.match(/\(([\d,]+)\)/);
        if (parenMatch) reviewCount = parseInt(parenMatch[1].replace(/,/g, ""));
      }
      // Strategy 3: any button whose text contains "N reviews"
      if (reviewCount === null) {
        for (const btn of Array.from(document.querySelectorAll("button, a"))) {
          const m = (btn.textContent ?? "").match(/([\d,]+)\s*review/i);
          if (m) { reviewCount = parseInt(m[1].replace(/,/g, "")); break; }
        }
      }

      // --- Category ---
      const category =
        text("button.DkEaL") ||
        text('[jsaction*="category"]') ||
        (document.querySelector(".YhemCb") as HTMLElement)?.innerText?.trim() ||
        "";

      // --- Address ---
      const addressEl =
        document.querySelector('[data-item-id="address"] .Io6YTe') ||
        document.querySelector('button[aria-label*="Address"] .Io6YTe') ||
        document.querySelector('[data-tooltip="Copy address"] .Io6YTe');
      const address = (addressEl as HTMLElement)?.innerText?.trim() ?? "";

      // --- Phone ---
      const phoneEl =
        document.querySelector('[data-item-id*="phone:tel"] .Io6YTe') ||
        document.querySelector('[data-tooltip="Copy phone number"] .Io6YTe') ||
        document.querySelector('[aria-label*="Phone"] .Io6YTe');
      const phone = (phoneEl as HTMLElement)?.innerText?.trim() || null;

      // --- Website ---
      const websiteEl =
        (document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement) ||
        (document.querySelector('a[aria-label*="website" i]') as HTMLAnchorElement);
      const website = websiteEl?.href || null;

      // --- Hours ---
      const hoursRows = Array.from(document.querySelectorAll("table.WgFkxc tr, .t39EBf tr"));
      const weekdayHours = hoursRows
        .map((r) => (r as HTMLElement).innerText?.trim())
        .filter(Boolean);

      // --- Open / closed ---
      const openEl =
        document.querySelector("span.ZDu9vd span") ||
        document.querySelector('[data-hide-tooltip-on-mobile] span');
      const openText = (openEl as HTMLElement)?.innerText?.toLowerCase() ?? "";
      let openNow: boolean | null = /open\s+now|open\s+24/i.test(openText)
        ? true
        : /\bclosed\b/i.test(openText)
        ? false
        : null;

      // --- Photo count ---
      // Strategy 1: aria-label on any element containing "photo" and a number
      const photoCountEl = document.querySelector('[aria-label*="photo" i]');
      const photoLabel = photoCountEl?.getAttribute("aria-label") ?? "";
      const photoMatch = photoLabel.match(/([\d,]+)/);
      let photoCount = photoMatch ? parseInt(photoMatch[1].replace(/,/g, ""), 10) : 0;
      // Strategy 2: text content "N photos"
      if (photoCount === 0) {
        for (const el of Array.from(document.querySelectorAll("button, a, span"))) {
          const m = (el.textContent ?? "").match(/([\d,]+)\s+photos?/i);
          if (m) { photoCount = parseInt(m[1].replace(/,/g, ""), 10); break; }
        }
      }
      // Strategy 3: scan all aria-labels on the page
      if (photoCount === 0) {
        for (const el of Array.from(document.querySelectorAll("[aria-label]"))) {
          const m = (el.getAttribute("aria-label") ?? "").match(/([\d,]+)\s*photos?/i);
          if (m) { photoCount = parseInt(m[1].replace(/,/g, ""), 10); break; }
        }
      }

      return {
        name,
        rating,
        reviewCount,
        category,
        address,
        phone,
        website,
        openNow,
        weekdayHours,
        photoCount,
      };
    });

    // Fallback: derive openNow from today's hours row (browser context can't reliably mutate let)
    let openNow = data.openNow;
    if (openNow === null && data.weekdayHours.length > 0) {
      const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const today = days[new Date().getDay()];
      const todayRow = data.weekdayHours.find((r) => r.includes(today)) ?? "";
      if (/open 24 hours/i.test(todayRow)) openNow = true;
      else if (/\bclosed\b/i.test(todayRow)) openNow = false;
      console.log(`[rank ${rank}] openNow fallback: today=${today} row="${todayRow}" → ${openNow}`);
    }

    return { rank, mapsUrl: url, ...data, openNow, todayHours: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.warn(`[rank ${rank}] failed: ${msg}`);
    return null;
  } finally {
    await page.close();
  }
}

async function dismissConsentBanner(page: Page): Promise<void> {
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
