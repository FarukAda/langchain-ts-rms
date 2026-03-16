import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { createRmsLifecycleTools } from "../../../../src/lib/rmsTool.js";
import type { RmsToolDeps } from "../../../../src/lib/types.js";

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

describe("createRmsLifecycleTools", () => {
  it("returns an array of 6 lifecycle tools", () => {
    const deps = makeMockDeps();
    const tools = createRmsLifecycleTools(deps);

    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(6);
  });

  it("includes all expected tool names", () => {
    const deps = makeMockDeps();
    const tools = createRmsLifecycleTools(deps);
    const names = tools.map((t) => t.name);

    expect(names).toContain("rms_get_research");
    expect(names).toContain("rms_list_research");
    expect(names).toContain("rms_search_research");
    expect(names).toContain("rms_delete_research");
    expect(names).toContain("rms_get_datetime");
    expect(names).toContain("rms_refresh_research");
  });

  it("each tool has a non-empty description", () => {
    const deps = makeMockDeps();
    const tools = createRmsLifecycleTools(deps);

    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});
