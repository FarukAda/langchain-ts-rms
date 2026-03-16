import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isResearchFresh,
  calculateExpiresAt,
  buildResearch,
  buildCompositeSummary,
  mergeResearchMetadata,
  getResearchAge,
  getResearchAgeDays,
} from "../../../src/domain/researchUtils.js";
import type { Research, SourceSummaryEntry } from "../../../src/domain/contracts.js";

function makeResearch(overrides: Partial<Research> = {}): Research {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    subject: "test",
    summary: "test summary",
    sourceSummaries: [],
    sourceUrls: [],
    searchQueries: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-08T00:00:00.000Z",
    status: "active",
    confidenceScore: 0.5,
    sourceCount: 0,
    tags: [],
    language: "en",
    rawResultCount: 0,
    metadata: {},
    ...overrides,
  };
}

const mockSourceSummaries: SourceSummaryEntry[] = [
  {
    url: "https://example.com/a",
    title: "Source A",
    keyTakeaways:
      "Key findings from Source A about the research topic with important details on implementation patterns and architectural decisions. The source covers practical examples of how to apply these techniques in production environments.",
    relevance: 0.8,
    tags: ["ai"],
    language: "en",
  },
  {
    url: "https://example.com/b",
    title: "Source B",
    keyTakeaways:
      "Key findings from Source B covering complementary aspects of the topic including safety considerations and risk mitigation strategies. The analysis provides a comprehensive framework for evaluating potential failure modes.",
    relevance: 0.6,
    tags: ["safety"],
    language: "en",
  },
];

describe("isResearchFresh", () => {
  it("returns true when expiresAt is in the future", () => {
    const r = makeResearch({ expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(isResearchFresh(r)).toBe(true);
  });

  it("returns false when expiresAt is in the past", () => {
    const r = makeResearch({ expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(isResearchFresh(r)).toBe(false);
  });

  it("returns false when expiresAt is undefined", () => {
    const r = makeResearch({ expiresAt: undefined });
    expect(isResearchFresh(r)).toBe(false);
  });

  it("uses provided 'now' for comparison", () => {
    const r = makeResearch({ expiresAt: "2026-06-01T00:00:00.000Z" });
    const beforeExpiry = new Date("2026-05-01T00:00:00.000Z");
    const afterExpiry = new Date("2026-07-01T00:00:00.000Z");
    expect(isResearchFresh(r, beforeExpiry)).toBe(true);
    expect(isResearchFresh(r, afterExpiry)).toBe(false);
  });
});

describe("calculateExpiresAt", () => {
  it("adds freshnessDays to the given date", () => {
    const result = calculateExpiresAt("2026-01-01T00:00:00.000Z", 7);
    expect(result).toBe("2026-01-08T00:00:00.000Z");
  });

  it("handles month boundaries", () => {
    const result = calculateExpiresAt("2026-01-28T00:00:00.000Z", 7);
    expect(new Date(result).getMonth()).toBe(1); // Feb
  });
});

describe("buildCompositeSummary", () => {
  it("creates structured summary from source summaries", () => {
    const summary = buildCompositeSummary(mockSourceSummaries);
    expect(summary).toContain("**Source A**");
    expect(summary).toContain("**Source B**");
    expect(summary).toContain("[Source: https://example.com/a]");
    expect(summary).toContain("Key findings from Source A");
  });

  it("returns fallback for empty sources", () => {
    expect(buildCompositeSummary([])).toBe("No sources available.");
  });

  it("filters out low-relevance sources (< 0.3)", () => {
    const sources: SourceSummaryEntry[] = [
      { ...mockSourceSummaries[0]!, relevance: 0.1 },
      { ...mockSourceSummaries[1]!, relevance: 0.8 },
    ];
    const summary = buildCompositeSummary(sources);
    expect(summary).not.toContain("Source A");
    expect(summary).toContain("Source B");
  });

  it("returns fallback when all sources are low-relevance", () => {
    const sources: SourceSummaryEntry[] = [
      { ...mockSourceSummaries[0]!, relevance: 0.1 },
      { ...mockSourceSummaries[1]!, relevance: 0.2 },
    ];
    expect(buildCompositeSummary(sources)).toBe("No sufficiently relevant sources found.");
  });
});

describe("buildResearch", () => {
  let uuidSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    uuidSpy = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue(
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as `${string}-${string}-${string}-${string}-${string}`,
      );
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- vitest spy type inference limitation
    uuidSpy.mockRestore();
  });

  it("creates a research object with auto-generated summary from sourceSummaries", () => {
    const r = buildResearch({ subject: "test topic", sourceSummaries: mockSourceSummaries });
    expect(r.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(r.subject).toBe("test topic");
    expect(r.status).toBe("active");
    expect(r.sourceSummaries).toHaveLength(2);
    expect(r.summary).toContain("**Source A**");
    expect(r.summary).toContain("**Source B**");
  });

  it("allows explicit summary override", () => {
    const r = buildResearch({
      subject: "test topic",
      sourceSummaries: mockSourceSummaries,
      summary: "Custom summary override",
    });
    expect(r.summary).toBe("Custom summary override");
    expect(r.sourceSummaries).toHaveLength(2);
  });

  it("uses defaults when no sourceSummaries provided", () => {
    const r = buildResearch({ subject: "test topic", summary: "A plain summary" });
    expect(r.sourceSummaries).toEqual([]);
    expect(r.summary).toBe("A plain summary");
    expect(r.confidenceScore).toBe(0.5);
    expect(r.sourceUrls).toEqual([]);
    expect(r.tags).toEqual([]);
    expect(r.language).toBe("en");
  });

  it("uses provided values over defaults", () => {
    const r = buildResearch({
      subject: "AI",
      sourceSummaries: mockSourceSummaries,
      sourceUrls: ["https://example.com"],
      confidenceScore: 0.9,
      tags: ["machine-learning"],
      language: "nl",
      tenantId: "t1",
      freshnessDays: 14,
    });
    expect(r.sourceUrls).toEqual(["https://example.com"]);
    expect(r.confidenceScore).toBe(0.9);
    expect(r.tags).toEqual(["machine-learning"]);
    expect(r.language).toBe("nl");
    expect(r.tenantId).toBe("t1");
    expect(r.sourceCount).toBe(1);
  });
});

describe("mergeResearchMetadata", () => {
  it("merges incoming over existing", () => {
    const result = mergeResearchMetadata({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });
});

describe("getResearchAge / getResearchAgeDays", () => {
  it("calculates age in milliseconds", () => {
    const r = makeResearch({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-02T00:00:00.000Z");
    expect(getResearchAge(r, now)).toBe(86400000);
  });

  it("calculates age in days", () => {
    const r = makeResearch({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const now = new Date("2026-01-08T00:00:00.000Z");
    expect(getResearchAgeDays(r, now)).toBe(7);
  });

  it("returns large age when updatedAt is missing", () => {
    const r = makeResearch({ updatedAt: undefined });
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(getResearchAge(r, now)).toBeGreaterThan(0);
  });
});
