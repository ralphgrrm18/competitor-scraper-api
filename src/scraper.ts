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
  mapsUrl: string;
  photoCount: number;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function scrapeGoogleMaps(
  keyword: string,
  lat: number,
  lng: number
): Promise<ScrapedBusiness[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
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

    // Block images/fonts to speed up loading
    await context.route(/\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf)(\?.*)?$/, (r) =>
      r.abort()
    );

    const placeLinks = await getPlaceLinks(context, keyword, lat, lng);

    if (!placeLinks.length) {
      await browser.close();
      return [];
    }

    // Scrape detail pages 3 at a time in parallel
    const results: ScrapedBusiness[] = [];
    const CONCURRENCY = 3;

    for (let i = 0; i < placeLinks.length; i += CONCURRENCY) {
      const batch = placeLinks.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((link, j) => scrapePlaceDetail(context, link, i + j + 1))
      );
      results.push(...(batchResults.filter(Boolean) as ScrapedBusiness[]));
    }

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

    // Scroll the feed to load more results
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (feed) feed.scrollTop += 800;
      });
      await delay(1200);
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
  // Retry once on failure — some pages need a second attempt
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await tryScrapePlaceDetail(context, url, rank, attempt);
    if (result) return result;
    if (attempt < 2) await delay(1500);
  }
  return null;
}

async function tryScrapePlaceDetail(
  context: BrowserContext,
  url: string,
  rank: number,
  attempt: number
): Promise<ScrapedBusiness | null> {
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsentBanner(page);

    // Wait for business name — try multiple selectors
    await page.waitForSelector("h1, h1.DUwDvf, [role='main'] h1", { timeout: 15000 });

    const data = await page.evaluate((): Omit<ScrapedBusiness, "rank" | "mapsUrl"> => {
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

      // --- Open / closed ---
      const openEl =
        document.querySelector("span.ZDu9vd span") ||
        document.querySelector('[data-hide-tooltip-on-mobile] span');
      const openText = (openEl as HTMLElement)?.innerText?.toLowerCase() ?? "";
      const openNow = openText.includes("open now")
        ? true
        : openText.includes("closed") || openText.includes("close")
        ? false
        : null;

      // --- Hours ---
      const hoursRows = Array.from(document.querySelectorAll("table.WgFkxc tr, .t39EBf tr"));
      const weekdayHours = hoursRows
        .map((r) => (r as HTMLElement).innerText?.trim())
        .filter(Boolean);

      // --- Photo count ---
      const photoCountEl = document.querySelector('[aria-label*="photo" i][aria-label*="See" i]');
      const photoLabel = photoCountEl?.getAttribute("aria-label") ?? "";
      const photoMatch = photoLabel.match(/([\d,]+)/);
      const photoCount = photoMatch ? parseInt(photoMatch[1].replace(/,/g, "")) : 0;

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

    return { rank, mapsUrl: url, ...data };
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.warn(`[rank ${rank}] attempt ${attempt} failed: ${msg}`);
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
