import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isBlockedUrl,
  filterBlockedUrls,
  getBlockedDomains,
  DEFAULT_BLOCKED_DOMAINS,
} from "../../../../src/infra/search/urlBlocklist.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { resetEnv } from "../../../../src/config/env.js";

beforeEach(() => {
  setLogSilent(true);
  resetEnv();
});
afterEach(() => {
  setLogSilent(false);
  vi.restoreAllMocks();
  resetEnv();
});

describe("isBlockedUrl", () => {
  it("blocks exact domain match", () => {
    expect(isBlockedUrl("https://amazon.com/product/123")).toBe(true);
  });

  it("blocks subdomain match", () => {
    expect(isBlockedUrl("https://shop.samsclub.com/item")).toBe(true);
  });

  it("blocks deeply nested subdomains", () => {
    expect(isBlockedUrl("https://us.shop.advanceautoparts.com/p/widget")).toBe(true);
  });

  it("allows non-blocked domains", () => {
    expect(isBlockedUrl("https://nodejs.org/api/typescript.html")).toBe(false);
    expect(isBlockedUrl("https://dev.to/some-article")).toBe(false);
    expect(isBlockedUrl("https://github.com/repo")).toBe(false);
  });

  it("does not block domains that merely contain a blocked domain as substring", () => {
    // "notamazon.com" should NOT be blocked even though it contains "amazon.com"
    expect(isBlockedUrl("https://notamazon.com/page")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isBlockedUrl("not-a-url")).toBe(false);
    expect(isBlockedUrl("")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isBlockedUrl("https://WALMART.COM/deals")).toBe(true);
    expect(isBlockedUrl("https://Shop.EBAY.com/item")).toBe(true);
  });

  it("accepts a custom blocklist", () => {
    const custom = ["spamsite.com"];
    expect(isBlockedUrl("https://spamsite.com/page", custom)).toBe(true);
    expect(isBlockedUrl("https://amazon.com/product", custom)).toBe(false);
  });
});

describe("getBlockedDomains", () => {
  it("returns default list when env var is not set", () => {
    const domains = getBlockedDomains();
    expect(domains).toEqual(DEFAULT_BLOCKED_DOMAINS);
  });

  it("merges env var domains with defaults", () => {
    vi.stubEnv("SEARXNG_URL_BLOCKLIST", "spamsite.com, junkmail.org");
    resetEnv();

    const domains = getBlockedDomains();
    expect(domains).toContain("spamsite.com");
    expect(domains).toContain("junkmail.org");
    // Defaults still present
    expect(domains).toContain("amazon.com");
  });

  it("handles whitespace and empty entries in env var", () => {
    vi.stubEnv("SEARXNG_URL_BLOCKLIST", " spamsite.com ,, , junkmail.org ");
    resetEnv();

    const domains = getBlockedDomains();
    expect(domains).toContain("spamsite.com");
    expect(domains).toContain("junkmail.org");
    expect(domains).not.toContain("");
  });
});

describe("filterBlockedUrls", () => {
  it("removes blocked URLs and keeps valid ones", () => {
    const items = [
      { url: "https://nodejs.org/api", title: "Node.js" },
      { url: "https://shop.advanceautoparts.com/?q=ts", title: "Spam" },
      { url: "https://dev.to/article", title: "Dev.to" },
      { url: "https://walmart.com/search", title: "Walmart" },
    ];

    const filtered = filterBlockedUrls(items, (i) => i.url);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((i) => i.title)).toEqual(["Node.js", "Dev.to"]);
  });

  it("returns all items when none are blocked", () => {
    const items = [
      { url: "https://nodejs.org", title: "A" },
      { url: "https://github.com", title: "B" },
    ];

    const filtered = filterBlockedUrls(items, (i) => i.url);
    expect(filtered).toHaveLength(2);
  });

  it("returns empty array when all items are blocked", () => {
    const items = [
      { url: "https://amazon.com/p", title: "A" },
      { url: "https://ebay.com/item", title: "B" },
    ];

    const filtered = filterBlockedUrls(items, (i) => i.url);
    expect(filtered).toHaveLength(0);
  });

  it("handles empty input", () => {
    const filtered = filterBlockedUrls([], (i: { url: string }) => i.url);
    expect(filtered).toHaveLength(0);
  });
});
