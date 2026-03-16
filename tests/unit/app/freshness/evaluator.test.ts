import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateFreshness } from "../../../../src/app/freshness/evaluator.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { ResearchRepository } from "../../../../src/infra/vector/researchRepository.js";
import type { Research } from "../../../../src/domain/contracts.js";

const mockResearch: Research = {
  id: "test-research-id",
  subject: "AI safety",
  summary: "Research about AI safety.",
  sourceSummaries: [],
  sourceUrls: ["https://example.com"],
  searchQueries: ["AI safety"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-08T00:00:00.000Z",
  status: "active",
  confidenceScore: 0.8,
  sourceCount: 1,
  tags: ["ai"],
  language: "en",
  rawResultCount: 5,
  metadata: {},
};

function mockRepository(results: Array<{ research: Research; score: number }> = []) {
  return {
    findBySubject: vi.fn().mockResolvedValue(results),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as ResearchRepository;
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("evaluateFreshness", () => {
  it("returns 'missing' when no cached research exists", async () => {
    const repo = mockRepository([]);
    const result = await evaluateFreshness("new topic", repo);

    expect(result.isFresh).toBe(false);
    expect(result.cachedResearch).toBeNull();
    expect(result.staleness).toBe("missing");
  });

  it("returns 'fresh' when cached research is within expiry", async () => {
    const repo = mockRepository([{ research: mockResearch, score: 0.9 }]);
    const now = new Date("2026-01-05T00:00:00.000Z"); // before expiresAt
    const result = await evaluateFreshness("AI safety", repo, { now });

    expect(result.isFresh).toBe(true);
    expect(result.cachedResearch).toEqual(mockResearch);
    expect(result.staleness).toBe("fresh");
    expect(result.score).toBe(0.9);
  });

  it("returns 'stale' when cached research is past expiry", async () => {
    const repo = mockRepository([{ research: mockResearch, score: 0.9 }]);
    const now = new Date("2026-01-10T00:00:00.000Z"); // after expiresAt
    const result = await evaluateFreshness("AI safety", repo, { now });

    expect(result.isFresh).toBe(false);
    expect(result.cachedResearch).toEqual(mockResearch);
    expect(result.staleness).toBe("stale");
  });

  it("passes tenantId to repository", async () => {
    const repo = mockRepository([]);
    await evaluateFreshness("test topic", repo, { tenantId: "tenant-1" });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock has no this binding
    expect(vi.mocked(repo.findBySubject)).toHaveBeenCalledWith("test topic", {
      tenantId: "tenant-1",
      k: 1,
    });
  });

  it("includes cacheAge and cacheAgeDays for cached entries", async () => {
    const repo = mockRepository([{ research: mockResearch, score: 0.9 }]);
    const now = new Date("2026-01-03T00:00:00.000Z");
    const result = await evaluateFreshness("AI safety", repo, { now });

    expect(result.cacheAge).toBeDefined();
    expect(result.cacheAgeDays).toBeDefined();
    if (result.cacheAgeDays !== undefined) {
      expect(result.cacheAgeDays).toBeCloseTo(2, 0);
    }
  });
});
