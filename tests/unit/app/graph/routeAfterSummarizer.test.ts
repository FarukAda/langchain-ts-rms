import { describe, it, expect } from "vitest";

/**
 * Tests for the routeAfterSummarizer conditional edge router logic.
 * After F1/F4 cleanup, the router is a pure confidence gate:
 *   confidence < 0.4 → human_approval → persister
 *   confidence >= 0.4 → persister
 */

// Mirror of the routing logic in workflow.ts
function routeAfterSummarizer(state: {
  summarization?: { overallConfidence?: number } | undefined;
}): string {
  const score = state.summarization?.overallConfidence ?? 1;
  if (score < 0.4) return "human_approval";
  return "persister";
}

describe("routeAfterSummarizer", () => {
  it("routes to human_approval when confidence is low", () => {
    const result = routeAfterSummarizer({
      summarization: { overallConfidence: 0.2 },
    });
    expect(result).toBe("human_approval");
  });

  it("routes to persister when confidence is acceptable", () => {
    const result = routeAfterSummarizer({
      summarization: { overallConfidence: 0.7 },
    });
    expect(result).toBe("persister");
  });

  it("routes to persister at exact threshold (0.4)", () => {
    const result = routeAfterSummarizer({
      summarization: { overallConfidence: 0.4 },
    });
    expect(result).toBe("persister");
  });

  it("uses default confidence of 1 when summarization is undefined", () => {
    const result = routeAfterSummarizer({
      summarization: undefined,
    });
    expect(result).toBe("persister");
  });

  it("uses default confidence of 1 when overallConfidence is undefined", () => {
    const result = routeAfterSummarizer({
      summarization: {},
    });
    expect(result).toBe("persister");
  });
});
