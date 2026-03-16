import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performSearch } from "../../../../src/infra/search/searxngClient.js";
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

/** Helper to mock global.fetch with a successful SearxNG JSON API response. */
function mockFetch(results: Array<Record<string, unknown>>, overrides?: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    query: "test",
    number_of_results: results.length,
    results,
    answers: [],
    suggestions: [],
    unresponsive_engines: [],
    ...overrides,
  };
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  } as Response);
}

describe("performSearch (direct fetch)", () => {
  it("parses SearxNG JSON API results with proper fields", async () => {
    mockFetch([
      {
        title: "AI Safety",
        url: "https://example.com/ai",
        content: "AI safety info",
        engine: "duckduckgo",
      },
      {
        title: "ML Basics",
        url: "https://example.com/ml",
        content: "ML overview",
        engine: "brave",
      },
    ]);

    const results = await performSearch("AI safety");

    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe("AI Safety");
    expect(results[0]!.url).toBe("https://example.com/ai");
    expect(results[0]!.snippet).toBe("AI safety info");
    expect(results[0]!.engine).toBe("duckduckgo");
    expect(results[1]!.url).toBe("https://example.com/ml");
    expect(results[1]!.snippet).toBe("ML overview");
  });

  it("limits results to numResults option", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet ${i}`,
      engine: "brave",
    }));
    mockFetch(items);

    const results = await performSearch("query", { numResults: 5 });
    expect(results).toHaveLength(5);
  });

  it("defaults to 10 results when numResults is not specified", async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet ${i}`,
      engine: "google",
    }));
    mockFetch(items);

    const results = await performSearch("query");
    expect(results).toHaveLength(10);
  });

  it("returns empty array when SearxNG returns no results", async () => {
    mockFetch([]);

    const results = await performSearch("empty query");
    expect(results).toHaveLength(0);
  });

  it("propagates HTTP errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: () => Promise.resolve({}),
    } as Response);

    await expect(performSearch("test")).rejects.toThrow("SearxNG returned HTTP 503");
  });

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    await expect(performSearch("test")).rejects.toThrow("fetch failed");
  });

  it("handles missing fields gracefully", async () => {
    mockFetch([{ title: "Partial" }]);

    const results = await performSearch("test");

    expect(results[0]!.title).toBe("Partial");
    expect(results[0]!.url).toBe("");
    expect(results[0]!.snippet).toBe("");
    expect(results[0]!.engine).toBe("unknown");
  });

  it("uses GET method with correct query parameters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ results: [], answers: [], suggestions: [], unresponsive_engines: [] }),
    } as unknown as Response);

    await performSearch("typescript best practices");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("/search?");
    expect(calledUrl).toContain("q=typescript+best+practices");
    expect(calledUrl).toContain("format=json");
    const callOpts = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(callOpts.method).toBe("GET");
  });

  it("filters blocked URLs from results", async () => {
    mockFetch([
      {
        title: "TypeScript Docs",
        url: "https://typescriptlang.org/docs",
        content: "TS documentation",
        engine: "brave",
      },
      {
        title: "Auto Parts",
        url: "https://shop.advanceautoparts.com/?q=typescript",
        content: "Buy parts",
        engine: "google",
      },
      {
        title: "Node.js Guide",
        url: "https://nodejs.org/guide",
        content: "Node guide",
        engine: "duckduckgo",
      },
      {
        title: "Walmart Deals",
        url: "https://walmart.com/search?q=code",
        content: "Deals",
        engine: "google",
      },
    ]);

    const results = await performSearch("typescript best practices");

    expect(results).toHaveLength(2);
    expect(results[0]!.title).toBe("TypeScript Docs");
    expect(results[1]!.title).toBe("Node.js Guide");
  });
});
