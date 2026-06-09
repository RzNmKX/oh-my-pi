/**
 * DuckDuckGo Web Search Provider
 *
 * Scrapes DDG's HTML endpoint. No API key required — always available as a
 * zero-config fallback when all other providers are unavailable.
 */
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { parseHTML } from "linkedom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 25;

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface DuckDuckGoSearchParams {
	query: string;
	num_results?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

/** Strip HTML tags from a snippet string. */
function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * DDG wraps outbound links in redirects like `//duckduckgo.com/l/?uddg=<encoded>`.
 * Extract the real destination URL from the `uddg` query parameter.
 */
function extractRealUrl(href: string): string | null {
	if (href.startsWith("http://") || href.startsWith("https://")) {
		// Already a direct URL (rare but possible)
		if (!href.includes("duckduckgo.com/l/")) return href;
	}

	// Normalize protocol-relative URLs
	const normalized = href.startsWith("//") ? `https:${href}` : href;

	try {
		const url = new URL(normalized);
		const uddg = url.searchParams.get("uddg");
		if (uddg) return uddg;
	} catch {
		// Not a valid URL
	}

	// If it's a plain http(s) URL that happened to contain duckduckgo.com/l/ but
	// no uddg param, return it directly rather than discarding.
	if (normalized.startsWith("http")) return normalized;

	return null;
}

async function callDuckDuckGo(params: DuckDuckGoSearchParams): Promise<SearchSource[]> {
	const fetchImpl = params.fetch ?? fetch;

	const body = new URLSearchParams({ q: params.query });

	const response = await fetchImpl(DDG_HTML_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": USER_AGENT,
		},
		body: body.toString(),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		throw new SearchProviderError(
			"duckduckgo",
			`DuckDuckGo error (${response.status}): ${await response.text()}`,
			response.status,
		);
	}

	const html = await response.text();
	const { document } = parseHTML(html);

	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const results: SearchSource[] = [];

	const resultElements = document.querySelectorAll(".result");
	for (const el of resultElements) {
		if (results.length >= numResults) break;

		const linkEl = el.querySelector("a.result__a");
		if (!linkEl) continue;

		const href = linkEl.getAttribute("href");
		if (!href) continue;

		const url = extractRealUrl(href);
		if (!url) continue;

		const title = linkEl.textContent?.trim() || url;

		const snippetEl = el.querySelector(".result__snippet");
		const snippetRaw = snippetEl?.innerHTML;
		const snippet = snippetRaw ? stripHtml(snippetRaw) || undefined : undefined;

		results.push({ title, url, snippet });
	}

	return results;
}

/** Execute DuckDuckGo web search. */
export async function searchDuckDuckGo(params: DuckDuckGoSearchParams): Promise<SearchResponse> {
	const sources = await callDuckDuckGo(params);

	return {
		provider: "duckduckgo",
		sources,
	};
}

/** Search provider for DuckDuckGo web search (HTML scraping, no API key). */
export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo";
	readonly label = "DuckDuckGo";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo({
			query: params.query,
			num_results: params.numSearchResults ?? params.limit,
			signal: params.signal,
			fetch: params.fetch,
		});
	}
}
