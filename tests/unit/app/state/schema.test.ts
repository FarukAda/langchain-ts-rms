import { describe, it, expect } from "vitest";
import { RmsStateAnnotation } from "../../../../src/app/state/schema.js";
import type { RmsPhase } from "../../../../src/app/state/schema.js";

describe("RmsStateAnnotation", () => {
  it("exports the annotation root", () => {
    expect(RmsStateAnnotation).toBeDefined();
  });

  it("spec contains expected keys", () => {
    const spec = RmsStateAnnotation.spec;
    const keys = Object.keys(spec);

    expect(keys).toContain("subject");
    expect(keys).toContain("tenantId");
    expect(keys).toContain("forceRefresh");
    expect(keys).toContain("maxResults");
    expect(keys).toContain("freshnessDays");
    expect(keys).toContain("cachedResearch");
    expect(keys).toContain("isFresh");
    expect(keys).toContain("searchResults");
    expect(keys).toContain("summarization");
    expect(keys).toContain("research");
    expect(keys).toContain("source");
    expect(keys).toContain("currentPhase");
    expect(keys).toContain("error");
    expect(keys).toContain("traceId");
    expect(keys).toContain("metadata");
  });
});

describe("RmsPhase type", () => {
  it("accepts valid phase values", () => {
    const phases: RmsPhase[] = ["freshness", "searching", "summarizing", "persisting"];
    expect(phases).toHaveLength(4);
  });
});
