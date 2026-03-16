import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { createResearchTool } from "../../../../src/lib/tools/research.js";
import type { RmsToolDeps } from "../../../../src/lib/types.js";

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

function makeMockDeps(): RmsToolDeps {
  return {
    researchRepository: {
      getById: vi.fn().mockResolvedValue(null),
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

describe("rms_research tool", () => {
  it("has the correct name and description", () => {
    const tool = createResearchTool(makeMockDeps());
    expect(tool.name).toBe("rms_research");
    expect(tool.description).toContain("Research a topic");
  });

  it("uses custom tool name when provided", () => {
    const tool = createResearchTool({ ...makeMockDeps(), toolName: "custom_research" });
    expect(tool.name).toBe("custom_research");
  });

  it("wraps errors in a response envelope", async () => {
    const deps = makeMockDeps();
    const tool = createResearchTool(deps);
    const raw = await tool.invoke({ subject: "test topic" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["error"]).toBeDefined();
    expect(result["version"]).toBe("1.0");
  });

  it("returns research when workflow succeeds", async () => {
    // Override the mock for this test to return successful state
    const { createRmsWorkflow } = await import("../../../../src/app/graph/workflow.js");
    const mockWorkflow = vi.mocked(createRmsWorkflow);
    mockWorkflow.mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        research: { id: "test-id", subject: "test", summary: "A test summary" },
        source: "web",
        error: undefined,
        cachedResearch: undefined,
      }),
    } as unknown as ReturnType<typeof createRmsWorkflow>);

    const deps = makeMockDeps();
    const tool = createResearchTool(deps);
    const raw = await tool.invoke({ subject: "test topic" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["version"]).toBe("1.0");
    expect(result["research"]).toBeDefined();
    expect(result["source"]).toBe("web");
    expect(result["error"]).toBeUndefined();
  });
});
