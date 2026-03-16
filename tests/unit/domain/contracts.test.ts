import { describe, it, expect } from "vitest";
import { ResearchSchema, ResearchStatusSchema } from "../../../src/domain/contracts.js";

describe("ResearchStatusSchema", () => {
  it("accepts valid statuses", () => {
    for (const s of ["active", "stale", "refreshing", "archived"]) {
      expect(ResearchStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects invalid status", () => {
    expect(() => ResearchStatusSchema.parse("deleted")).toThrow();
  });
});

describe("ResearchSchema", () => {
  const validResearch = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    subject: "AI safety",
    summary: "Research summary about AI safety practices.",
    sourceUrls: ["https://example.com/article"],
    searchQueries: ["AI safety practices"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    status: "active" as const,
    confidenceScore: 0.85,
    sourceCount: 1,
    tenantId: "tenant-1",
    tags: ["ai", "safety"],
    language: "en",
    rawResultCount: 5,
    metadata: { origin: "test" },
  };

  it("parses a fully-populated research object", () => {
    const result = ResearchSchema.parse(validResearch);
    expect(result.id).toBe(validResearch.id);
    expect(result.subject).toBe("AI safety");
    expect(result.confidenceScore).toBe(0.85);
    expect(result.tags).toEqual(["ai", "safety"]);
  });

  it("applies defaults for optional fields", () => {
    const minimal = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      subject: "Minimal",
      summary: "A minimal entry",
    };
    const result = ResearchSchema.parse(minimal);
    expect(result.status).toBe("active");
    expect(result.confidenceScore).toBe(0.5);
    expect(result.sourceUrls).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(result.language).toBe("en");
    expect(result.metadata).toEqual({});
  });

  it("rejects missing required fields", () => {
    expect(() => ResearchSchema.parse({ id: "abc" })).toThrow();
    expect(() => ResearchSchema.parse({ subject: "test" })).toThrow();
  });

  it("rejects invalid UUID for id", () => {
    expect(() => ResearchSchema.parse({ id: "not-a-uuid", subject: "x", summary: "y" })).toThrow();
  });

  it("rejects empty subject", () => {
    expect(() =>
      ResearchSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        subject: "",
        summary: "y",
      }),
    ).toThrow();
  });

  it("clamps confidenceScore to 0..1 range via schema", () => {
    expect(() =>
      ResearchSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        subject: "x",
        summary: "y",
        confidenceScore: 1.5,
      }),
    ).toThrow();

    expect(() =>
      ResearchSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        subject: "x",
        summary: "y",
        confidenceScore: -0.1,
      }),
    ).toThrow();
  });
});
