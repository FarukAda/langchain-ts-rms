import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rerankSearchResults, cosineSimilarity } from "../../../../src/app/reranking/reranker.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { SearxngSearchResult } from "../../../../src/infra/search/searxngClient.js";

const mockResults: SearxngSearchResult[] = [
  {
    title: "Result A",
    url: "https://a.com",
    snippet: "Highly relevant content about React.",
    engine: "google",
  },
  {
    title: "Result B",
    url: "https://b.com",
    snippet: "Cooking recipes for pasta.",
    engine: "bing",
  },
  {
    title: "Result C",
    url: "https://c.com",
    snippet: "React hooks documentation.",
    engine: "google",
  },
];

function mockEmbeddings(vectors: number[][]): EmbeddingsInterface {
  return {
    embedDocuments: vi.fn().mockResolvedValue(vectors),
    embedQuery: vi.fn().mockResolvedValue(vectors[0]),
  } as unknown as EmbeddingsInterface;
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("rerankSearchResults", () => {
  it("returns empty array for empty results", async () => {
    const embeddings = mockEmbeddings([]);
    const ranked = await rerankSearchResults("test", [], embeddings);
    expect(ranked).toEqual([]);
  });

  it("ranks results by cosine similarity to subject", async () => {
    // subject = [1,0,0], A = [0.9,0.1,0], B = [0,0,1], C = [0.95,0.05,0]
    const embeddings = mockEmbeddings([
      [1, 0, 0], // subject
      [0.9, 0.1, 0], // A: high similarity
      [0, 0, 1], // B: low similarity
      [0.95, 0.05, 0], // C: highest similarity
    ]);

    const ranked = await rerankSearchResults("React hooks", mockResults, embeddings, {
      minScore: 0,
    });

    expect(ranked.length).toBe(3);
    // C should be first (highest similarity), then A, then B
    expect(ranked[0]!.result.title).toBe("Result C");
    expect(ranked[1]!.result.title).toBe("Result A");
    expect(ranked[2]!.result.title).toBe("Result B");
  });

  it("filters out results below minScore threshold", async () => {
    // subject = [1,0], A = [0.95,0.3], B = [0.1,0.99]; B is near-orthogonal
    const embeddings = mockEmbeddings([
      [1, 0], // subject
      [0.95, 0.3], // A: high similarity
      [0.1, 0.99], // B: low similarity to subject
    ]);

    const ranked = await rerankSearchResults("React", mockResults.slice(0, 2), embeddings, {
      minScore: 0.8,
    });

    // Only A should pass the threshold
    expect(ranked.length).toBe(1);
    expect(ranked[0]!.result.title).toBe("Result A");
  });

  it("respects topN option", async () => {
    const embeddings = mockEmbeddings([
      [1, 0, 0],
      [0.9, 0.1, 0],
      [0.8, 0.2, 0],
      [0.95, 0.05, 0],
    ]);

    const ranked = await rerankSearchResults("test", mockResults, embeddings, { topN: 2 });

    expect(ranked.length).toBe(2);
  });

  it("handles missing subject vector gracefully", async () => {
    const embeddings = mockEmbeddings([]);
    // embedDocuments returns empty array
    (embeddings.embedDocuments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const ranked = await rerankSearchResults("test", mockResults, embeddings);

    // Should return all results with score 0
    expect(ranked.length).toBe(3);
    expect(ranked.every((r) => r.score === 0)).toBe(true);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns 0 for zero vector", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});
