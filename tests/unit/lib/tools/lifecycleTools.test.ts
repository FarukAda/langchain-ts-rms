import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { createGetResearchTool } from "../../../../src/lib/tools/getResearch.js";
import { createDeleteResearchTool } from "../../../../src/lib/tools/deleteResearch.js";
import { createListResearchTool } from "../../../../src/lib/tools/listResearch.js";
import { createSearchResearchTool } from "../../../../src/lib/tools/searchResearch.js";
import type { RmsToolDeps } from "../../../../src/lib/types.js";
import type { Research } from "../../../../src/domain/contracts.js";

const mockResearch: Research = {
  id: "550e8400-e29b-41d4-a716-446655440000",
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

function makeMockDeps(overrides: Partial<RmsToolDeps> = {}): RmsToolDeps {
  return {
    researchRepository: {
      getById: vi.fn().mockResolvedValue(mockResearch),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({
        items: [mockResearch],
        total: 1,
        limit: 20,
        offset: 0,
      }),
      search: vi.fn().mockResolvedValue([{ research: mockResearch, score: 0.95 }]),
      upsert: vi.fn().mockResolvedValue(undefined),
      findBySubject: vi.fn().mockResolvedValue([]),
      findStale: vi.fn().mockResolvedValue([]),
    } as unknown as RmsToolDeps["researchRepository"],
    chatModel: {} as RmsToolDeps["chatModel"],
    ...overrides,
  };
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("rms_get_research", () => {
  it("returns research entry by ID", async () => {
    const deps = makeMockDeps();
    const tool = createGetResearchTool(deps);
    const raw = await tool.invoke({ researchId: "550e8400-e29b-41d4-a716-446655440000" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["version"]).toBe("1.0");
    const research = result["research"] as Record<string, unknown>;
    expect(research["id"]).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(research["subject"]).toBe("AI safety");
  });

  it("accepts research_id alias", async () => {
    const deps = makeMockDeps();
    const tool = createGetResearchTool(deps);
    const raw = await tool.invoke({ research_id: "550e8400-e29b-41d4-a716-446655440000" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["research"]).toBeDefined();
  });

  it("returns error when research not found", async () => {
    const deps = makeMockDeps({
      researchRepository: {
        ...makeMockDeps().researchRepository,
        getById: vi.fn().mockResolvedValue(null),
      } as unknown as RmsToolDeps["researchRepository"],
    });
    const tool = createGetResearchTool(deps);
    const raw = await tool.invoke({ researchId: "nonexistent" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
  });
});

describe("rms_delete_research", () => {
  it("deletes and confirms", async () => {
    const deps = makeMockDeps();
    const tool = createDeleteResearchTool(deps);
    const raw = await tool.invoke({ researchId: "550e8400-e29b-41d4-a716-446655440000" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["deleted"]).toBe(true);
    expect(result["researchId"]).toBe("550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("rms_list_research", () => {
  it("returns paginated list", async () => {
    const deps = makeMockDeps();
    const tool = createListResearchTool(deps);
    const raw = await tool.invoke({});
    const result = JSON.parse(raw) as { version: string; total: number; items: unknown[] };
    expect(result.version).toBe("1.0");
    expect(result.total).toBe(1);
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("passes filters to repository", async () => {
    const deps = makeMockDeps();
    const tool = createListResearchTool(deps);
    await tool.invoke({ status: ["active"], tenantId: "t1", limit: "5" });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock has no this binding
    expect(vi.mocked(deps.researchRepository.list)).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["active"],
        tenantId: "t1",
        limit: 5,
      }),
    );
  });
});

describe("rms_search_research", () => {
  it("returns search results with scores", async () => {
    const deps = makeMockDeps();
    const tool = createSearchResearchTool(deps);
    const raw = await tool.invoke({ query: "AI safety" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["version"]).toBe("1.0");
    expect(result["total"]).toBe(1);
    const results = result["results"] as Array<{ score: number }>;
    expect(results[0]!.score).toBe(0.95);
  });
});
