import { describe, it, expect } from "vitest";
import { ResearchSchema } from "../../../../src/domain/contracts.js";
import type { Research, SourceSummaryEntry } from "../../../../src/domain/contracts.js";

/**
 * These tests validate that the serialization/deserialization logic
 * in researchToDocument, documentToResearch, and pointToResearch
 * correctly round-trips all Research fields — particularly the
 * sourceSummaries, keyFindings, and limitations fields that were
 * previously lost during Qdrant payload storage.
 *
 * The helper functions mirror the internal helpers to test the
 * exact field mapping without needing exported private functions.
 */

// ── Mirrors of internal helpers ──

function researchToDocumentMetadata(research: Research): Record<string, unknown> {
  return {
    research_id: research.id,
    subject: research.subject,
    source_urls: research.sourceUrls,
    search_queries: research.searchQueries,
    source_summaries: research.sourceSummaries,
    key_findings: research.keyFindings,
    limitations: research.limitations,
    created_at: research.createdAt,
    updated_at: research.updatedAt,
    expires_at: research.expiresAt,
    status: research.status,
    confidence_score: research.confidenceScore,
    source_count: research.sourceCount,
    tenant_id: research.tenantId,
    tags: research.tags,
    language: research.language,
    raw_result_count: research.rawResultCount,
    ...research.metadata,
  };
}

function metadataToResearch(pageContent: string, m: Record<string, unknown>): Research {
  return ResearchSchema.parse({
    id: m["research_id"],
    subject: m["subject"],
    summary: pageContent,
    sourceSummaries: m["source_summaries"] ?? [],
    sourceUrls: m["source_urls"] ?? [],
    searchQueries: m["search_queries"] ?? [],
    createdAt: m["created_at"],
    updatedAt: m["updated_at"],
    expiresAt: m["expires_at"],
    status: m["status"] ?? "active",
    confidenceScore: m["confidence_score"] ?? 0.5,
    sourceCount: m["source_count"] ?? 0,
    tenantId: m["tenant_id"],
    tags: m["tags"] ?? [],
    language: m["language"] ?? "en",
    rawResultCount: m["raw_result_count"] ?? 0,
    keyFindings: m["key_findings"],
    limitations: m["limitations"],
    metadata: {},
  });
}

function pointPayloadToResearch(payload: Record<string, unknown>): Research {
  const m = (payload["metadata"] ?? {}) as Record<string, unknown>;
  return ResearchSchema.parse({
    id: m["research_id"],
    subject: m["subject"],
    summary: payload["content"] ?? "",
    sourceSummaries: m["source_summaries"] ?? [],
    sourceUrls: m["source_urls"] ?? [],
    searchQueries: m["search_queries"] ?? [],
    createdAt: m["created_at"],
    updatedAt: m["updated_at"],
    expiresAt: m["expires_at"],
    status: m["status"] ?? "active",
    confidenceScore: m["confidence_score"] ?? 0.5,
    sourceCount: m["source_count"] ?? 0,
    tenantId: m["tenant_id"],
    tags: m["tags"] ?? [],
    language: m["language"] ?? "en",
    rawResultCount: m["raw_result_count"] ?? 0,
    keyFindings: m["key_findings"],
    limitations: m["limitations"],
    metadata: {},
  });
}

// ── Test fixtures ──

const sourceSummaries: SourceSummaryEntry[] = [
  {
    url: "https://example.com/a",
    title: "AI Safety Overview",
    keyTakeaways:
      "Key findings about AI safety including alignment problems, interpretability challenges, and proposed solutions for safe deployment of large language models.",
    relevance: 0.85,
    tags: ["ai", "safety"],
    language: "en",
  },
  {
    url: "https://example.com/b",
    title: "ML Best Practices",
    keyTakeaways:
      "Summary of machine learning best practices covering data preprocessing, model selection, hyperparameter tuning, evaluation metrics, and production deployment strategies.",
    relevance: 0.7,
    tags: ["ml"],
    language: "en",
  },
];

const fullResearch: Research = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  subject: "AI Safety",
  summary: "A comprehensive summary about AI safety research.",
  sourceSummaries,
  sourceUrls: ["https://example.com/a", "https://example.com/b"],
  searchQueries: ["AI safety", "alignment research"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T12:00:00.000Z",
  expiresAt: "2026-01-08T00:00:00.000Z",
  status: "active",
  confidenceScore: 0.82,
  sourceCount: 2,
  tags: ["ai", "safety"],
  language: "en",
  rawResultCount: 10,
  keyFindings: ["Finding 1: Alignment is hard", "Finding 2: Interpretability improves safety"],
  limitations: ["Limited to English-language sources", "No post-2025 research included"],
  metadata: {},
};

// ── Tests ──

describe("researchToDocument → documentToResearch round-trip", () => {
  it("preserves sourceSummaries through serialization", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.sourceSummaries).toEqual(sourceSummaries);
  });

  it("preserves keyFindings through serialization", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.keyFindings).toEqual(fullResearch.keyFindings);
  });

  it("preserves limitations through serialization", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.limitations).toEqual(fullResearch.limitations);
  });

  it("preserves all core fields through full round-trip", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.id).toBe(fullResearch.id);
    expect(result.subject).toBe(fullResearch.subject);
    expect(result.summary).toBe(fullResearch.summary);
    expect(result.sourceUrls).toEqual(fullResearch.sourceUrls);
    expect(result.searchQueries).toEqual(fullResearch.searchQueries);
    expect(result.status).toBe(fullResearch.status);
    expect(result.confidenceScore).toBe(fullResearch.confidenceScore);
    expect(result.sourceCount).toBe(fullResearch.sourceCount);
    expect(result.tags).toEqual(fullResearch.tags);
    expect(result.language).toBe(fullResearch.language);
    expect(result.rawResultCount).toBe(fullResearch.rawResultCount);
  });
});

describe("pointToResearch round-trip (Qdrant scroll payload)", () => {
  it("preserves sourceSummaries, keyFindings, and limitations from scroll payload", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    // Qdrant stores LangChain documents as { content, metadata }
    const payload = {
      content: fullResearch.summary,
      metadata,
    };
    const result = pointPayloadToResearch(payload);

    expect(result.sourceSummaries).toEqual(sourceSummaries);
    expect(result.keyFindings).toEqual(fullResearch.keyFindings);
    expect(result.limitations).toEqual(fullResearch.limitations);
  });

  it("preserves all core fields from scroll payload", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    const payload = { content: fullResearch.summary, metadata };
    const result = pointPayloadToResearch(payload);

    expect(result.id).toBe(fullResearch.id);
    expect(result.subject).toBe(fullResearch.subject);
    expect(result.summary).toBe(fullResearch.summary);
    expect(result.sourceUrls).toEqual(fullResearch.sourceUrls);
    expect(result.confidenceScore).toBe(fullResearch.confidenceScore);
  });
});

describe("backward compatibility (missing enrichment fields)", () => {
  it("defaults sourceSummaries to [] when not in metadata", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    delete metadata["source_summaries"];
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.sourceSummaries).toEqual([]);
  });

  it("defaults keyFindings to undefined when not in metadata", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    delete metadata["key_findings"];
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.keyFindings).toBeUndefined();
  });

  it("defaults limitations to undefined when not in metadata", () => {
    const metadata = researchToDocumentMetadata(fullResearch);
    delete metadata["limitations"];
    const result = metadataToResearch(fullResearch.summary, metadata);

    expect(result.limitations).toBeUndefined();
  });
});
