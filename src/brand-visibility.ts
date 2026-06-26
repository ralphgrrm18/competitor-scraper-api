// ─── Types ───────────────────────────────────────────────────────────────────

interface SerpOrganicResult {
  position?: number;
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerpKnowledgeGraph {
  description?: string;
}

interface SerpSitelinks {
  inline?: { title?: string }[];
  expanded?: { title?: string }[];
}

interface SerpLocalResult {
  position?: number;
  title?: string;
  rating?: number;
  reviews?: number;
  address?: string;
  phone?: string;
  website?: string;
}

interface SerpNewsResult {
  title?: string;
  link?: string;
  source?: string | { name?: string };
  date?: string;
  snippet?: string;
}

interface SerpGoogleResponse {
  organic_results?: SerpOrganicResult[];
  knowledge_graph?: SerpKnowledgeGraph;
  sitelinks?: SerpSitelinks;
  local_results?: SerpLocalResult[];
  news_results?: SerpNewsResult[];
  top_stories?: SerpNewsResult[];
  search_information?: { total_results?: string };
  error?: string;
}

interface SerpNewsResponse {
  news_results?: SerpNewsResult[];
  error?: string;
}

// ─── Public types (consumed by frontend) ─────────────────────────────────────

export interface BrandedResult {
  position: number;
  title: string;
  url: string;
  snippet: string;
  isBrandDomain: boolean;
}

export interface NewsMention {
  title: string;
  url: string;
  source: string;
  date: string;
  snippet: string;
}

export interface SerpFeature {
  type: string;
  label: string;
  present: boolean;
  detail?: string;
}

export interface LocalPresence {
  name: string;
  rating: number | null;
  reviewCount: number | null;
  position: number | null;
  address: string | null;
  phone: string | null;
  website: string | null;
}

export interface BrandVisibilityResult {
  brandName: string;
  domain: string;
  scrapedAt: string;
  totalResultsEstimate: string | null;
  domainFirstPosition: number | null;
  organicResults: BrandedResult[];
  serpFeatures: SerpFeature[];
  newsMentions: NewsMention[];
  localPresence: LocalPresence | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDomain(domain: string): string {
  return domain
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase()
    .trim();
}

function extractSourceName(source: string | { name?: string } | undefined): string {
  if (!source) return "";
  if (typeof source === "string") return source;
  return source.name ?? "";
}

// ─── SerpAPI: organic search + SERP features ─────────────────────────────────

async function fetchOrganicAndFeatures(
  brandName: string,
  domain: string,
  apiKey: string
): Promise<{
  organicResults: BrandedResult[];
  serpFeatures: SerpFeature[];
  totalResultsEstimate: string | null;
  localPresence: LocalPresence | null;
  newsFromMain: NewsMention[];
}> {
  const params = new URLSearchParams({
    engine: "google",
    q: brandName,
    hl: "en",
    gl: "us",
    num: "10",
    api_key: apiKey,
  });

  const res = await fetch(`https://serpapi.com/search?${params}`);
  const data = (await res.json()) as SerpGoogleResponse;

  if (data.error) throw new Error(`SerpAPI: ${data.error}`);

  const normalizedDomain = normalizeDomain(domain);

  const organicResults: BrandedResult[] = (data.organic_results ?? []).slice(0, 10).map((r, i) => {
    const url = r.link ?? "";
    return {
      position: r.position ?? i + 1,
      title: r.title ?? "",
      url,
      snippet: r.snippet ?? "",
      isBrandDomain: url.toLowerCase().includes(normalizedDomain),
    };
  });

  const hasSitelinks = !!(
    data.sitelinks?.inline?.length || data.sitelinks?.expanded?.length
  );
  const hasLocalPack = !!(data.local_results?.length);
  const hasNews = !!(data.news_results?.length || data.top_stories?.length);

  const serpFeatures: SerpFeature[] = [
    {
      type: "knowledge_panel",
      label: "Knowledge Panel",
      present: !!data.knowledge_graph,
      detail: data.knowledge_graph?.description?.slice(0, 120),
    },
    {
      type: "sitelinks",
      label: "Sitelinks",
      present: hasSitelinks,
    },
    {
      type: "local_pack",
      label: "Local Pack",
      present: hasLocalPack,
      detail: hasLocalPack ? `${data.local_results!.length} businesses shown` : undefined,
    },
    {
      type: "news",
      label: "News Results",
      present: hasNews,
    },
  ];

  // First local result that matches the brand name (or fall back to position 1)
  const firstWord = brandName.toLowerCase().split(" ")[0];
  const localMatch =
    data.local_results?.find((r) =>
      r.title?.toLowerCase().includes(firstWord)
    ) ?? data.local_results?.[0];

  const localPresence: LocalPresence | null = localMatch
    ? {
        name: localMatch.title ?? brandName,
        rating: localMatch.rating ?? null,
        reviewCount: localMatch.reviews ?? null,
        position: localMatch.position ?? null,
        address: localMatch.address ?? null,
        phone: localMatch.phone ?? null,
        website: localMatch.website ?? null,
      }
    : null;

  const newsSource = data.top_stories ?? data.news_results ?? [];
  const newsFromMain: NewsMention[] = newsSource.slice(0, 3).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    source: extractSourceName(r.source),
    date: r.date ?? "",
    snippet: r.snippet ?? "",
  }));

  return {
    organicResults,
    serpFeatures,
    totalResultsEstimate: data.search_information?.total_results ?? null,
    localPresence,
    newsFromMain,
  };
}

// ─── SerpAPI: Google News ─────────────────────────────────────────────────────

async function fetchNewsMentions(brandName: string, apiKey: string): Promise<NewsMention[]> {
  const params = new URLSearchParams({
    engine: "google_news",
    q: brandName,
    hl: "en",
    gl: "us",
    api_key: apiKey,
  });

  const res = await fetch(`https://serpapi.com/search?${params}`);
  const data = (await res.json()) as SerpNewsResponse;

  if (data.error) {
    console.warn("[brand-visibility] news search error:", data.error);
    return [];
  }

  return (data.news_results ?? []).slice(0, 10).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    source: extractSourceName(r.source),
    date: r.date ?? "",
    snippet: r.snippet ?? "",
  }));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getBrandVisibility(
  brandName: string,
  domain: string
): Promise<BrandVisibilityResult> {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error("SERPAPI_API_KEY is not set");

  const [mainResults, newsResults] = await Promise.all([
    fetchOrganicAndFeatures(brandName, domain, apiKey),
    fetchNewsMentions(brandName, apiKey),
  ]);

  // Merge news: Google News results first, then any from main SERP, deduplicated by URL
  const seenUrls = new Set<string>();
  const allNews: NewsMention[] = [];
  for (const item of [...newsResults, ...mainResults.newsFromMain]) {
    if (item.url && !seenUrls.has(item.url)) {
      seenUrls.add(item.url);
      allNews.push(item);
    }
  }

  return {
    brandName,
    domain,
    scrapedAt: new Date().toISOString(),
    totalResultsEstimate: mainResults.totalResultsEstimate,
    domainFirstPosition:
      mainResults.organicResults.find((r) => r.isBrandDomain)?.position ?? null,
    organicResults: mainResults.organicResults,
    serpFeatures: mainResults.serpFeatures,
    newsMentions: allNews.slice(0, 10),
    localPresence: mainResults.localPresence,
  };
}
