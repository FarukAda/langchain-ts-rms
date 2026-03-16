import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../src/infra/observability/tracing.js";
import { evaluateFreshness } from "../../../src/app/freshness/evaluator.js";
import type { ResearchRepository } from "../../../src/infra/vector/researchRepository.js";
import type { Research } from "../../../src/domain/contracts.js";

const mockResearch: Research = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  subject: "AI safety",
  summary: "Summary",
  sourceSummaries: [],
  sourceUrls: [],
  searchQueries: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
  status: "active",
  confidenceScore: 0.8,
  sourceCount: 0,
  tags: [],
  language: "en",
  rawResultCount: 0,
  metadata: {},
};

function makeMockRepo(findBySubjectResult: Array<{ research: Research; score: number }> = []) {
  return {
    findBySubject: vi.fn().mockResolvedValue(findBySubjectResult),
    getById: vi.fn(),
    upsert: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    list: vi.fn(),
    deleteByIds: vi.fn(),
    findStale: vi.fn(),
  } as unknown as ResearchRepository;
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("evaluateFreshness", () => {
  it("returns 'missing' when no cached research exists", async () => {
    const repo = makeMockRepo([]);
    const result = await evaluateFreshness("AI safety", repo);
    expect(result.staleness).toBe("missing");
    expect(result.isFresh).toBe(false);
    expect(result.cachedResearch).toBeNull();
  });

  it("returns 'fresh' when cached research has not expired", async () => {
    const repo = makeMockRepo([{ research: mockResearch, score: 0.9 }]);
    const now = new Date("2026-01-15T00:00:00.000Z"); // before expiresAt
    const result = await evaluateFreshness("AI safety", repo, { now });
    expect(result.staleness).toBe("fresh");
    expect(result.isFresh).toBe(true);
    expect(result.cachedResearch).toBeDefined();
    expect(result.score).toBe(0.9);
  });

  it("returns 'stale' when cached research has expired", async () => {
    const repo = makeMockRepo([{ research: mockResearch, score: 0.9 }]);
    const now = new Date("2026-03-01T00:00:00.000Z"); // after expiresAt
    const result = await evaluateFreshness("AI safety", repo, { now });
    expect(result.staleness).toBe("stale");
    expect(result.isFresh).toBe(false);
    expect(result.cachedResearch).toBeDefined();
  });

  it("passes tenantId to repository search", async () => {
    const repo = makeMockRepo([]);
    await evaluateFreshness("test", repo, { tenantId: "t1" });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock has no this binding
    expect(vi.mocked(repo.findBySubject)).toHaveBeenCalledWith("test", { tenantId: "t1", k: 1 });
  });

  it("returns cacheAge and cacheAgeDays", async () => {
    const repo = makeMockRepo([{ research: mockResearch, score: 0.5 }]);
    const now = new Date("2026-01-08T00:00:00.000Z"); // 7 days after updatedAt
    const result = await evaluateFreshness("test", repo, { now });
    expect(result.cacheAge).toBe(7 * 24 * 60 * 60 * 1000);
    expect(result.cacheAgeDays).toBe(7);
  });
});
