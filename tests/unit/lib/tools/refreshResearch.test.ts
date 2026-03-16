import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { createRefreshResearchTool } from "../../../../src/lib/tools/refreshResearch.js";
import type { RmsToolDeps } from "../../../../src/lib/types.js";
import type { Research } from "../../../../src/domain/contracts.js";

// Mock the workflow module so the tool uses a fake graph instead of real infra
vi.mock("../../../../src/app/graph/workflow.js", () => ({
  createRmsWorkflow: vi.fn().mockReturnValue({
    invoke: vi.fn().mockRejectedValue(new Error("Mocked workflow error")),
  }),
  RMS_NODE_NAMES: {
    FRESHNESS_CHECKER: "freshnessChecker",
    GUARDRAIL: "guardrail",
    QUERY_PLANNER: "queryPlanner",
    SEARCHER: "searcher",
    QUERY_REWRITER: "queryRewriter",
    RERANKER: "reranker",
    HUMAN_APPROVAL: "human_approval",
    SUMMARIZER: "summarizer",
    PERSISTER: "persister",
  },
}));

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

function makeMockDeps(): RmsToolDeps {
  return {
    researchRepository: {
      getById: vi.fn().mockResolvedValue(mockResearch),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 }),
      search: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue(undefined),
      findBySubject: vi.fn().mockResolvedValue([]),
      findStale: vi.fn().mockResolvedValue([]),
    } as unknown as RmsToolDeps["researchRepository"],
    chatModel: {} as RmsToolDeps["chatModel"],
  };
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("rms_refresh_research tool", () => {
  it("has the correct name", () => {
    const tool = createRefreshResearchTool(makeMockDeps());
    expect(tool.name).toBe("rms_refresh_research");
  });

  it("returns error when research entry not found", async () => {
    const deps = makeMockDeps();
    (deps.researchRepository.getById as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const tool = createRefreshResearchTool(deps);
    const raw = await tool.invoke({ researchId: "nonexistent" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
  });

  it("wraps errors from the graph workflow in response envelope", async () => {
    const deps = makeMockDeps();
    // getById returns a valid entry, but workflow mock rejects → error
    const tool = createRefreshResearchTool(deps);
    const raw = await tool.invoke({ researchId: mockResearch.id });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
    expect(result["version"]).toBe("1.0");
  });

  it("returns refreshed research when workflow succeeds", async () => {
    const { createRmsWorkflow } = await import("../../../../src/app/graph/workflow.js");
    const mockWorkflow = vi.mocked(createRmsWorkflow);
    mockWorkflow.mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        research: { id: "new-id", subject: "AI safety", summary: "Refreshed summary" },
        source: "web",
        error: undefined,
        cachedResearch: mockResearch,
      }),
    } as unknown as ReturnType<typeof createRmsWorkflow>);

    const deps = makeMockDeps();
    const tool = createRefreshResearchTool(deps);
    const raw = await tool.invoke({ researchId: mockResearch.id });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["version"]).toBe("1.0");
    expect(result["research"]).toBeDefined();
    expect(result["wasRefreshed"]).toBe(true);
    expect(result["previousResearchId"]).toBe(mockResearch.id);
    expect(result["error"]).toBeUndefined();
  });
});
