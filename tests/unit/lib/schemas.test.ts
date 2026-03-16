import { describe, it, expect } from "vitest";
import {
  RmsResearchInputSchema,
  laxBool,
  laxInt,
  laxFloat,
} from "../../../src/lib/schemas/researchSchemas.js";
import {
  GetResearchInputSchema,
  ListResearchInputSchema,
  SearchResearchInputSchema,
  DeleteResearchInputSchema,
  RefreshResearchInputSchema,
  coerceLifecycleInput,
} from "../../../src/lib/schemas/lifecycleSchemas.js";

// ── Lax types ──

describe("laxBool", () => {
  it("passes through native booleans", () => {
    expect(laxBool.parse(true)).toBe(true);
    expect(laxBool.parse(false)).toBe(false);
  });

  it("accepts string representations without transforming", () => {
    // Strings pass through as-is; coercion happens in coerceLifecycleInput
    expect(laxBool.parse("true")).toBe("true");
    expect(laxBool.parse("false")).toBe("false");
  });

  it("rejects non-string non-boolean", () => {
    expect(() => laxBool.parse(42)).toThrow();
  });
});

describe("laxInt", () => {
  it("passes through native integers", () => {
    expect(laxInt.parse(42)).toBe(42);
  });

  it("accepts numeric strings without transforming", () => {
    // Strings pass through as-is; coercion happens in coerceLifecycleInput
    expect(laxInt.parse("42")).toBe("42");
  });

  it("accepts any string (coercion is pre-parse)", () => {
    // laxInt is now z.union([z.number().int(), z.string()])
    expect(laxInt.parse("abc")).toBe("abc");
  });
});

describe("laxFloat", () => {
  it("passes through native numbers", () => {
    expect(laxFloat.parse(3.14)).toBe(3.14);
  });

  it("accepts numeric strings without transforming", () => {
    // Strings pass through as-is; coercion is pre-parse
    expect(laxFloat.parse("3.14")).toBe("3.14");
  });
});

// ── Research input schema ──

describe("RmsResearchInputSchema", () => {
  it("accepts subject as primary field", () => {
    const result = RmsResearchInputSchema.parse({ subject: "AI safety" });
    expect(result.subject).toBe("AI safety");
  });

  it("accepts topic as alias for subject", () => {
    const result = RmsResearchInputSchema.parse({ topic: "AI safety" });
    expect(result.topic).toBe("AI safety");
  });

  it("accepts query as alias for subject", () => {
    const result = RmsResearchInputSchema.parse({ query: "climate" });
    expect(result.query).toBe("climate");
  });

  it("accepts question as alias for subject", () => {
    const result = RmsResearchInputSchema.parse({ question: "What is ML?" });
    expect(result.question).toBe("What is ML?");
  });

  it("rejects when no subject alias is provided", () => {
    expect(() => RmsResearchInputSchema.parse({ tenantId: "t1" })).toThrow();
  });

  it("accepts optional fields", () => {
    const result = RmsResearchInputSchema.parse({
      subject: "test",
      forceRefresh: true,
      maxResults: 5,
      tenantId: "t1",
    });
    expect(result.forceRefresh).toBe(true);
    expect(result.maxResults).toBe(5);
  });

  it("accepts string booleans for forceRefresh (coercion is pre-parse)", () => {
    const result = RmsResearchInputSchema.parse({
      subject: "test",
      forceRefresh: "true",
    });
    // With JSON Schema–safe schemas, string passes through; coerceLifecycleInput handles conversion
    expect(result.forceRefresh).toBe("true");
  });
});

// ── Lifecycle schemas ──

describe("GetResearchInputSchema", () => {
  it("accepts researchId", () => {
    const result = GetResearchInputSchema.parse({ researchId: "abc-123" });
    expect(result.researchId).toBe("abc-123");
  });

  it("accepts research_id alias", () => {
    const result = GetResearchInputSchema.parse({ research_id: "abc-123" });
    expect(result.research_id).toBe("abc-123");
  });

  it("accepts id alias", () => {
    const result = GetResearchInputSchema.parse({ id: "abc-123" });
    expect(result.id).toBe("abc-123");
  });

  it("rejects when all ID fields are missing", () => {
    expect(() => GetResearchInputSchema.parse({})).toThrow();
  });
});

describe("ListResearchInputSchema", () => {
  it("accepts empty input (all optional)", () => {
    const result = ListResearchInputSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts status filter", () => {
    const result = ListResearchInputSchema.parse({ status: ["active", "stale"] });
    expect(result.status).toEqual(["active", "stale"]);
  });

  it("accepts limit as string (coercion is pre-parse)", () => {
    const result = ListResearchInputSchema.parse({ limit: "20" });
    // laxInt now passes strings through; coerceLifecycleInput handles conversion
    expect(result.limit).toBe("20");
  });
});

describe("SearchResearchInputSchema", () => {
  it("requires query", () => {
    expect(() => SearchResearchInputSchema.parse({})).toThrow();
  });

  it("accepts query with optional filters", () => {
    const result = SearchResearchInputSchema.parse({
      query: "machine learning",
      tags: ["ml"],
      limit: 3,
    });
    expect(result.query).toBe("machine learning");
    expect(result.tags).toEqual(["ml"]);
  });
});

describe("DeleteResearchInputSchema", () => {
  it("accepts researchId", () => {
    const result = DeleteResearchInputSchema.parse({ researchId: "x" });
    expect(result.researchId).toBe("x");
  });

  it("rejects empty input", () => {
    expect(() => DeleteResearchInputSchema.parse({})).toThrow();
  });
});

describe("RefreshResearchInputSchema", () => {
  it("accepts researchId with optional maxResults", () => {
    const result = RefreshResearchInputSchema.parse({
      researchId: "r1",
      maxResults: "15",
    });
    expect(result.researchId).toBe("r1");
    // laxInt passes strings through; coercion is pre-parse
    expect(result.maxResults).toBe("15");
  });

  it("rejects empty input", () => {
    expect(() => RefreshResearchInputSchema.parse({})).toThrow();
  });
});

// ── coerceLifecycleInput ──

describe("coerceLifecycleInput", () => {
  it("converts 'null' string to actual null", () => {
    const result = coerceLifecycleInput({ status: "null" });
    expect(result.status).toBeNull();
  });

  it("wraps single string in array for array fields", () => {
    const result = coerceLifecycleInput({ status: "active" });
    expect(result.status).toEqual(["active"]);
  });

  it("converts empty string to undefined for array fields", () => {
    const result = coerceLifecycleInput({ tags: "" });
    expect(result.tags).toBeUndefined();
  });

  it("filters null strings from arrays", () => {
    const result = coerceLifecycleInput({ tags: ["valid", "null", ""] });
    expect(result.tags).toEqual(["valid"]);
  });

  it("coerces string booleans for bool fields", () => {
    expect(coerceLifecycleInput({ forceRefresh: "true" }).forceRefresh).toBe(true);
    expect(coerceLifecycleInput({ forceRefresh: "false" }).forceRefresh).toBe(false);
    expect(coerceLifecycleInput({ force_refresh: "yes" }).force_refresh).toBe(true);
    expect(coerceLifecycleInput({ force_refresh: "0" }).force_refresh).toBe(false);
  });

  it("coerces string integers for int fields", () => {
    expect(coerceLifecycleInput({ maxResults: "10" }).maxResults).toBe(10);
    expect(coerceLifecycleInput({ limit: "50" }).limit).toBe(50);
    expect(coerceLifecycleInput({ offset: "20" }).offset).toBe(20);
    expect(coerceLifecycleInput({ max_results: "abc" }).max_results).toBeUndefined();
  });

  it("passes through non-coerced values untouched", () => {
    const result = coerceLifecycleInput({ query: "test", limit: 5 });
    expect(result.query).toBe("test");
    expect(result.limit).toBe(5);
  });
});
