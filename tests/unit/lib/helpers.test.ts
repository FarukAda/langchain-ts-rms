import { describe, it, expect } from "vitest";
import {
  stripNulls,
  normalizeInput,
  paginate,
  wrapToolResponse,
  matchesFilters,
} from "../../../src/lib/helpers.js";
import type { Research } from "../../../src/domain/contracts.js";

describe("stripNulls", () => {
  it("replaces null with undefined", () => {
    expect(stripNulls(null)).toBeUndefined();
  });

  it("leaves non-null values untouched", () => {
    expect(stripNulls("hello")).toBe("hello");
    expect(stripNulls(42)).toBe(42);
    expect(stripNulls(true)).toBe(true);
  });

  it("recursively strips nulls from objects", () => {
    const input = { a: null, b: "keep", c: { d: null, e: 1 } };
    const result = stripNulls(input);
    expect(result).toEqual({ a: undefined, b: "keep", c: { d: undefined, e: 1 } });
  });

  it("handles arrays with null elements", () => {
    expect(stripNulls([1, null, "x"])).toEqual([1, undefined, "x"]);
  });
});

describe("normalizeInput", () => {
  it("resolves subject from topic alias", () => {
    const result = normalizeInput({ topic: "AI safety" });
    expect(result["subject"]).toBe("AI safety");
  });

  it("resolves subject from query alias", () => {
    const result = normalizeInput({ query: "climate change" });
    expect(result["subject"]).toBe("climate change");
  });

  it("resolves subject from question alias", () => {
    const result = normalizeInput({ question: "What is ML?" });
    expect(result["subject"]).toBe("What is ML?");
  });

  it("keeps existing subject over aliases", () => {
    const result = normalizeInput({ subject: "original", topic: "alias" });
    expect(result["subject"]).toBe("original");
  });

  it("resolves tenantId from tenant_id alias", () => {
    const result = normalizeInput({ tenant_id: "t1" });
    expect(result["tenantId"]).toBe("t1");
  });

  it("resolves researchId from research_id alias", () => {
    const result = normalizeInput({ research_id: "r1" });
    expect(result["researchId"]).toBe("r1");
  });

  it("resolves researchId from id alias", () => {
    const result = normalizeInput({ id: "i1" });
    expect(result["researchId"]).toBe("i1");
  });

  it("resolves forceRefresh from force_refresh alias", () => {
    const result = normalizeInput({ force_refresh: true });
    expect(result["forceRefresh"]).toBe(true);
  });

  it("resolves maxResults from max_results alias", () => {
    const result = normalizeInput({ max_results: 5 });
    expect(result["maxResults"]).toBe(5);
  });
});

describe("paginate", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it("returns first page", () => {
    expect(paginate(items, 3, 0)).toEqual([1, 2, 3]);
  });

  it("returns middle page", () => {
    expect(paginate(items, 3, 3)).toEqual([4, 5, 6]);
  });

  it("returns partial last page", () => {
    expect(paginate(items, 3, 9)).toEqual([10]);
  });

  it("returns empty for out-of-range offset", () => {
    expect(paginate(items, 3, 20)).toEqual([]);
  });
});

describe("wrapToolResponse", () => {
  it("includes version field", () => {
    const result = JSON.parse(wrapToolResponse({ data: "test" })) as {
      version: string;
      data: string;
    };
    expect(result.version).toBe("1.0");
    expect(result.data).toBe("test");
  });
});

describe("matchesFilters", () => {
  const research: Research = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    subject: "test",
    summary: "test summary",
    sourceSummaries: [],
    sourceUrls: [],
    searchQueries: [],
    status: "active",
    confidenceScore: 0.5,
    sourceCount: 0,
    tenantId: "t1",
    tags: [],
    language: "en",
    rawResultCount: 0,
    metadata: {},
  };

  it("matches when no filters are set", () => {
    expect(matchesFilters(research)).toBe(true);
  });

  it("matches when status matches", () => {
    expect(matchesFilters(research, ["active"])).toBe(true);
  });

  it("rejects when status does not match", () => {
    expect(matchesFilters(research, ["stale"])).toBe(false);
  });

  it("matches when tenantId matches", () => {
    expect(matchesFilters(research, undefined, "t1")).toBe(true);
  });

  it("rejects when tenantId does not match", () => {
    expect(matchesFilters(research, undefined, "t2")).toBe(false);
  });

  it("matches when both status and tenantId match", () => {
    expect(matchesFilters(research, ["active", "stale"], "t1")).toBe(true);
  });
});
