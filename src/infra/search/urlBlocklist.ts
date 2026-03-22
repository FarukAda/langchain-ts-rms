import { loadEnv } from "../../config/env.js";
import { logInfo } from "../observability/tracing.js";

/**
 * Hardcoded list of domains that never produce useful technical content.
 * Matching is done on hostname suffix, so `samsclub.com` also blocks
 * `shop.samsclub.com`.
 */
export const DEFAULT_BLOCKED_DOMAINS: readonly string[] = [
  "advanceautoparts.com",
  "samsclub.com",
  "walmart.com",
  "target.com",
  "ebay.com",
  "amazon.com",
  "aliexpress.com",
  "wish.com",
  "etsy.com",
  "bestbuy.com",
  "homedepot.com",
  "lowes.com",
  "costco.com",
  "wayfair.com",
  "overstock.com",
];

/**
 * Returns the merged blocklist: hardcoded defaults + user-supplied domains
 * from the `SEARXNG_URL_BLOCKLIST` env var (comma-separated).
 */
export function getBlockedDomains(): readonly string[] {
  const env = loadEnv();
  const extra = env.SEARXNG_URL_BLOCKLIST;
  if (!extra) return DEFAULT_BLOCKED_DOMAINS;

  const userDomains = extra
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  return [...DEFAULT_BLOCKED_DOMAINS, ...userDomains];
}

/**
 * Checks whether a URL's hostname matches any blocked domain.
 * Uses suffix matching so blocking `example.com` also blocks `shop.example.com`.
 *
 * @returns `true` if the URL should be filtered out.
 */
export function isBlockedUrl(url: string, blocklist?: readonly string[]): boolean {
  const domains = blocklist ?? getBlockedDomains();
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URLs are not blocked — let downstream handle them
    return false;
  }

  return domains.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`));
}

/**
 * Filters out items whose URL matches the blocklist and logs the count of
 * removed items for diagnostics.
 *
 * @param items   - Array of items to filter
 * @param getUrl  - Accessor to extract the URL from each item
 * @returns Filtered array with blocked items removed
 */
export function filterBlockedUrls<T>(items: readonly T[], getUrl: (item: T) => string): T[] {
  const blocklist = getBlockedDomains();
  const filtered = items.filter((item) => !isBlockedUrl(getUrl(item), blocklist));
  const removedCount = items.length - filtered.length;

  if (removedCount > 0) {
    logInfo("Blocked URLs filtered from search results", {
      removedCount,
      remainingCount: filtered.length,
    });
  }

  return filtered;
}
