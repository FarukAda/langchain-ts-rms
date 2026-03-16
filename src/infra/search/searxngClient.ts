import { loadEnv } from "../../config/env.js";
import { logInfo, logWarn, logError, ErrorCodes } from "../observability/tracing.js";
import { searchLimiter, type TokenBucketLimiter } from "../rateLimit/rateLimiter.js";
import { searchBreaker, type CircuitBreaker } from "../rateLimit/circuitBreaker.js";
import { filterBlockedUrls } from "./urlBlocklist.js";

export interface SearxngSearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

/**
 * Native SearxNG JSON API response shape.
 * @see https://docs.searxng.org/dev/search_api.html
 */
interface SearxngApiResponse {
  query: string;
  number_of_results: number;
  results: Array<{
    url: string;
    title: string;
    content: string;
    engine: string;
    engines: string[];
    score: number;
    category: string;
  }>;
  answers: string[];
  suggestions: string[];
  unresponsive_engines: Array<[string, string]>;
}

/** Default request timeout for SearxNG API calls (ms). */
const SEARXNG_TIMEOUT_MS = 15_000;

/**
 * Performs a web search via the SearxNG JSON API and returns typed results.
 *
 * This calls the SearxNG `/search` endpoint directly via `fetch()` instead
 * of going through LangChain's `SearxngSearch.invoke()`, which has multiple
 * issues:
 *   - Returns comma-separated JSON objects (not a valid JSON array)
 *   - Uses `link` instead of `url` as the key, losing URL info during parsing
 *   - Hardcoded 5s AbortSignal that kills slow engines
 *   - Sends POST with content-type JSON while SearxNG expects GET
 *
 * The API base URL is always read from `SEARXNG_API_BASE` env var.
 */
export async function performSearch(
  query: string,
  options?: {
    numResults?: number;
    /** Override the default search rate limiter (for DI/testing). */
    limiter?: TokenBucketLimiter;
    /** Override the default search circuit breaker (for DI/testing). */
    breaker?: CircuitBreaker;
  },
): Promise<SearxngSearchResult[]> {
  const env = loadEnv();
  const apiBase = env.SEARXNG_API_BASE;
  const limit = options?.numResults ?? 10;
  const limiter = options?.limiter ?? searchLimiter;
  const breaker = options?.breaker ?? searchBreaker;

  logInfo("SearXNG search", { query, numResults: limit });

  // Build query parameters for the SearxNG JSON API
  const params = new URLSearchParams({
    q: query,
    format: "json",
  });
  if (env.SEARXNG_ENGINES) params.set("engines", env.SEARXNG_ENGINES);
  if (env.SEARXNG_LANGUAGE) params.set("language", env.SEARXNG_LANGUAGE);
  if (env.SEARXNG_TIME_RANGE) params.set("time_range", env.SEARXNG_TIME_RANGE);

  const url = `${apiBase}/search?${params.toString()}`;

  return breaker.execute(async () => {
    try {
      await limiter.acquire();
      const resp = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(SEARXNG_TIMEOUT_MS),
      });

      if (!resp.ok) {
        throw new Error(`SearxNG returned HTTP ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as SearxngApiResponse;

      // Log unresponsive engines for diagnostics
      if (data.unresponsive_engines?.length) {
        logWarn("SearxNG unresponsive engines", {
          engines: data.unresponsive_engines
            .map(([name, reason]) => `${name}: ${reason}`)
            .join(", "),
        });
      }

      // Map native SearxNG results to our typed interface
      const rawResults: SearxngSearchResult[] = data.results.slice(0, limit).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
        engine: r.engine ?? r.engines?.[0] ?? "unknown",
      }));

      // Remove spam/commercial URLs before they consume result slots
      const results = filterBlockedUrls(rawResults, (r) => r.url);

      logInfo("SearXNG results", {
        query,
        resultCount: results.length,
        totalResults: data.number_of_results,
        answersCount: data.answers?.length ?? 0,
      });

      return results;
    } catch (err) {
      logError("SearXNG search failed", {
        errorCode: ErrorCodes.SEARCH_FAILED,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}
