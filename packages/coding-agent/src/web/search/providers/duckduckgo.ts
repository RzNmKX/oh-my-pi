/**
 * DuckDuckGo Web Search Provider
 *
 * Zero-config fallback that scrapes DuckDuckGo's HTML endpoint.
 * No API key required. Always available as the last-resort provider.
 */
import { parseHTML } from "linkedom";

import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 25;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface DdgRawResult {
	title: string;
	url: string;
	snippet?: string;
}

/** Extract the real URL from a DDG redirect link. */
function extractUrl(href: string): string | undefined {
	// DDG wraps results in //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
	try {
		// Handle protocol-relative URLs
		const absolute = href.startsWith("//") ? `https:${href}` : href;
		const parsed = new URL(absolute);
		const uddg = parsed.searchParams.get("uddg");
		if (uddg) return uddg;
	} catch {
		// Not a redirect link — return raw href if it looks like a URL
	}
	if (href.startsWith("http")) return href;
	return undefined;
}

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").trim();
}

/** Fetch and parse DuckDuckGo HTML search results. */
async function fetchDdgResults(query: string, numResults: number, signal?: AbortSignal): Promise<DdgRawResult[]> {
	const body = new URLSearchParams({ q: query });

	const response = await fetch(DDG_HTML_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": USER_AGENT,
		},
		body: body.toString(),
		signal,
	});

	if (!response.ok) {
		throw new SearchProviderError("duckduckgo", `DuckDuckGo returned HTTP ${response.status}`, response.status);
	}

	const html = await response.text();
	const { document } = parseHTML(html);
	const results: DdgRawResult[] = [];

	const resultElements = document.querySelectorAll(".result");
	for (const el of resultElements) {
		if (results.length >= numResults) break;

		const linkEl = el.querySelector("a.result__a");
		if (!linkEl) continue;

		const href = linkEl.getAttribute("href");
		if (!href) continue;

		const url = extractUrl(href);
		if (!url) continue;

		const title = stripHtml(linkEl.innerHTML || "").replace(/\s+/g, " ") || url;
		const snippetEl = el.querySelector("a.result__snippet, .result__snippet");
		const snippet = snippetEl ? stripHtml(snippetEl.innerHTML || "").replace(/\s+/g, " ") : undefined;

		results.push({ title, url, snippet });
	}

	return results;
}

/** Execute DuckDuckGo web search. */
export async function searchDuckDuckGo(params: {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
}): Promise<SearchResponse> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const raw = await fetchDdgResults(params.query, numResults, params.signal);

	const sources: SearchSource[] = raw.map(r => ({
		title: r.title,
		url: r.url,
		snippet: r.snippet,
	}));

	return {
		provider: "duckduckgo",
		sources,
	};
}

/** Search provider for DuckDuckGo (zero-config fallback). */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(): boolean {
		return true; // Always available — no API key needed
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
		});
	}
}
