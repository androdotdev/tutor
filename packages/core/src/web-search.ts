// Web search for the author flow. DuckDuckGo's HTML endpoint needs no API key
// and returns parseable result anchors; results are capped and snippets
// truncated so the model gets a compact, safe summary (external text, never
// course files). The fetch impl is injectable for tests.

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchFn = (query: string) => Promise<WebSearchResult[]>;

export const MAX_WEB_RESULTS = 5;
export const MAX_WEB_SNIPPET = 300;
const SEARCH_TIMEOUT_MS = 10_000;

const decodeHtml = (s: string): string =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Resolve a DDG redirect link (`//duckduckgo.com/l/?uddg=<target>`) to its target. */
function resolveUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.startsWith("//") ? `https:${href}` : href);
  } catch {
    return null;
  }
  const target = url.searchParams.get("uddg");
  return target ?? url.href;
}

/**
 * Search the web for `query`. Returns up to MAX_WEB_RESULTS results, newest
 * engine order, snippet-truncated. Throws on transport/HTTP errors so callers
 * can decide how to surface them.
 */
export async function searchWeb(query: string, fetchImpl: typeof fetch = fetch): Promise<WebSearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const res = await fetchImpl(url, {
    headers: { "user-agent": "lyceum-tutor/0.0.8 (course authoring research)" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`web search ${res.status}: ${res.statusText}`);
  }
  const html = await res.text();

  const results: WebSearchResult[] = [];
  // Title anchors: <a ... class="result__a" ... href="...">Title</a>
  const titleRe = /<a\b(?=[^>]*class="[^"]*result__a[^"]*")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippet anchors: <a ... class="result__snippet" ...>Snippet text</a>
  const snippetRe = /<a\b(?=[^>]*class="[^"]*result__snippet[^"]*")[^>]*>([\s\S]*?)<\/a>/g;

  const titles: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && titles.length < MAX_WEB_RESULTS) {
    const url = resolveUrl(m[1]);
    if (!url) continue;
    titles.push({ url, title: decodeHtml(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < MAX_WEB_RESULTS) {
    snippets.push(decodeHtml(m[1]));
  }
  for (let i = 0; i < titles.length; i++) {
    const snippet = (snippets[i] ?? "").slice(0, MAX_WEB_SNIPPET);
    results.push({ ...titles[i], snippet });
  }
  return results;
}
