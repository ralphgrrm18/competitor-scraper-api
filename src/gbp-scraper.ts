import { chromium, Page } from "playwright";

export interface GBPAttribute {
  section: string;
  items: string[];
}

export interface GBPDetail {
  gbpUrl: string;
  name: string;
  rating: number | null;
  reviewCount: number | null;
  category: string;
  address: string;
  phone: string | null;
  website: string | null;
  photoCount: number | null;
  latestReviewRecency: string | null;
  attributes: GBPAttribute[];
  metaTitle: string | null;
  metaDescription: string | null;
  metaKeywords: string | null;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function dismissConsent(page: Page): Promise<void> {
  for (const sel of ['button[aria-label="Accept all"]', 'button:has-text("Accept all")', "#L2AGLb"]) {
    try { await page.click(sel, { timeout: 2500 }); return; } catch {}
  }
}

export async function scrapeGBPDetail(url: string): Promise<GBPDetail> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-zygote", "--single-process",
      "--disable-features=TranslateUI",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
    });
    await context.route(/\.(png|jpg|jpeg|gif|webp|woff2?|ttf|mp4|mp3)(\?.*)?$/, (r) => r.abort());

    const page = await context.newPage();
    console.log(`[gbp] ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsent(page);
    await page.waitForSelector("h1.DUwDvf", { timeout: 15000 });
    await page.waitForTimeout(1000);

    const main = await page.evaluate((): {
      name: string; rating: number | null; reviewCount: number | null;
      category: string; address: string; phone: string | null;
      website: string | null; photoCount: number | null; latestReviewRecency: string | null;
    } => {
      const name = (document.querySelector("h1.DUwDvf") as HTMLElement)?.innerText?.trim() ?? "";

      // Rating via aria-label ("4.8 stars") — more stable than class selectors
      const ratingEl = document.querySelector('[aria-label*=" stars"]') as HTMLElement | null;
      const ratingAriaMatch = ratingEl?.getAttribute("aria-label")?.match(/([\d,.]+)\s*stars?/i);
      const rating = ratingAriaMatch ? parseFloat(ratingAriaMatch[1].replace(",", ".")) : null;

      // Review count via aria-label on the reviews button
      const reviewBtn = document.querySelector('[aria-label*="reviews"]') as HTMLElement | null;
      const reviewAriaMatch = reviewBtn?.getAttribute("aria-label")?.match(/([\d,]+)/);
      const reviewCount = reviewAriaMatch ? parseInt(reviewAriaMatch[1].replace(/,/g, "")) : null;

      // Category
      const category = (document.querySelector("button.DkEaL") as HTMLElement)?.innerText?.trim() ?? "";

      // Address
      const addrEl = document.querySelector('[data-item-id="address"] .Io6YTe, [data-item-id="address"] .rogA2c') as HTMLElement | null;
      const address = addrEl?.innerText?.trim() ?? "";

      // Phone
      const phoneEl = document.querySelector('[data-tooltip="Copy phone number"] .Io6YTe, [data-item-id^="phone:tel"] .Io6YTe') as HTMLElement | null;
      const phone = phoneEl?.innerText?.trim() || null;

      // Website
      const websiteEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null;
      const website = websiteEl?.href || null;

      // Photo count — look for "X photos" text anywhere on the page
      const allText = document.body.innerText;
      const photoMatch = allText.match(/(\d[\d,]*)\s*photos?/i);
      const photoCount = photoMatch ? parseInt(photoMatch[1].replace(/,/g, "")) : null;

      // Latest review recency from visible reviews
      const recencyPat = /\b(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i;
      const recencyEl = Array.from(document.querySelectorAll("span, div"))
        .map((el) => (el as HTMLElement).innerText?.trim() ?? "")
        .filter((t) => t.length > 0 && t.length < 30)
        .find((t) => recencyPat.test(t)) ?? null;
      const latestReviewRecency = recencyEl ? (recencyEl.match(recencyPat)?.[0] ?? null) : null;

      return { name, rating, reviewCount, category, address, phone, website, photoCount, latestReviewRecency };
    });

    // About tab — attributes
    const attributes: GBPAttribute[] = [];
    try {
      const tabs = await page.$$('button[role="tab"]');
      let aboutTab: (typeof tabs)[0] | null = null;
      for (const tab of tabs) {
        const text = await tab.innerText();
        if (/about/i.test(text)) { aboutTab = tab; break; }
      }

      if (aboutTab) {
        await aboutTab.click();
        await page.waitForTimeout(1500);

        const raw = await page.evaluate((): Array<{ section: string; items: string[] }> => {
          const result: Array<{ section: string; items: string[] }> = [];

          // Approach 1: aria-label^="Has " items (available attributes)
          const hasItems = Array.from(document.querySelectorAll('[aria-label^="Has "], [aria-label^="Serves "], [aria-label^="Offers "]'));
          if (hasItems.length > 0) {
            const sectionMap = new Map<string, string[]>();
            for (const item of hasItems) {
              const rawLabel = item.getAttribute("aria-label") ?? "";
              const label = rawLabel.replace(/^(Has|Serves|Offers)\s+/i, "");
              // walk up to find a heading
              let el: Element | null = item;
              let sectionName = "Attributes";
              for (let i = 0; i < 8; i++) {
                el = el?.parentElement ?? null;
                if (!el) break;
                const h = el.querySelector("h2, h3");
                if (h) { sectionName = h.textContent?.trim() ?? sectionName; break; }
              }
              if (!sectionMap.has(sectionName)) sectionMap.set(sectionName, []);
              sectionMap.get(sectionName)!.push(label);
            }
            for (const [section, items] of sectionMap) result.push({ section, items });
            return result;
          }

          // Approach 2: h2 headings + following content
          const pane = document.querySelector(".m6QErb") ?? document.querySelector('[role="region"]');
          if (!pane) return result;
          const headings = pane.querySelectorAll("h2, h3");
          for (const h of headings) {
            const section = h.textContent?.trim() ?? "";
            const items: string[] = [];
            let sib = h.nextElementSibling;
            while (sib && !["H2", "H3"].includes(sib.tagName)) {
              sib.querySelectorAll("span, li").forEach((el) => {
                const t = (el as HTMLElement).innerText?.trim() ?? "";
                if (t && t.length < 60 && !items.includes(t)) items.push(t);
              });
              sib = sib.nextElementSibling;
            }
            if (section && items.length) result.push({ section, items });
          }
          return result;
        });

        attributes.push(...raw.filter((a) => a.items.length > 0));
      }
    } catch (e) {
      console.log("[gbp] attributes error:", e);
    }

    // Meta tags from website homepage
    let metaTitle: string | null = null;
    let metaDescription: string | null = null;
    let metaKeywords: string | null = null;

    if (main.website) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(main.website, {
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT },
          redirect: "follow",
        });
        clearTimeout(timer);
        const html = await res.text();

        metaTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;

        metaDescription =
          html.match(/<meta\s+name=["']description["'][^>]*content=["']([^"']*)/i)?.[1]?.trim() ??
          html.match(/<meta\s+content=["']([^"']*?)["'][^>]*name=["']description["']/i)?.[1]?.trim() ??
          null;

        metaKeywords =
          html.match(/<meta\s+name=["']keywords["'][^>]*content=["']([^"']*)/i)?.[1]?.trim() ??
          html.match(/<meta\s+content=["']([^"']*?)["'][^>]*name=["']keywords["']/i)?.[1]?.trim() ??
          null;
      } catch (e) {
        console.log("[gbp] meta fetch error:", e);
      }
    }

    return { gbpUrl: url, ...main, attributes, metaTitle, metaDescription, metaKeywords };
  } finally {
    await browser.close();
  }
}
