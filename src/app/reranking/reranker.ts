import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { SearxngSearchResult } from "../../infra/search/searxngClient.js";
import { logInfo, logDebug, withNodeTiming } from "../../infra/observability/tracing.js";

export interface RerankOptions {
  /** Minimum cosine similarity score to keep a result. Defaults to 0.3. */
  minScore?: number;
  /** Maximum number of results to return after re-ranking. Defaults to input length. */
  topN?: number;
}

export interface RankedResult {
  result: SearxngSearchResult;
  score: number;
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Re-ranks search results by embedding-based semantic similarity to the subject.
 *
 * 1. Embeds the subject and each result snippet
 * 2. Computes cosine similarity between subject and each snippet
 * 3. Filters out results below `minScore`
 * 4. Sorts by descending similarity
 * 5. Returns top-N results
 */
export async function rerankSearchResults(
  subject: string,
  results: SearxngSearchResult[],
  embeddings: EmbeddingsInterface,
  options?: RerankOptions,
  traceId?: string,
): Promise<RankedResult[]> {
  if (results.length === 0) return [];

  const minScore = options?.minScore ?? 0;
  const topN = options?.topN ?? results.length;

  return withNodeTiming("reranker", traceId, subject, async () => {
    // Build texts for embedding: subject + each snippet
    const snippets = results.map((r) => `${r.title}\n${r.snippet}`);
    const allTexts = [subject, ...snippets];

    logDebug("Embedding for re-ranking", {
      node: "reranker",
      traceId,
      researchId: subject,
    });

    const vectors = await embeddings.embedDocuments(allTexts);
    const subjectVector = vectors[0];
    if (!subjectVector) {
      return results.map((r) => ({ result: r, score: 0 }));
    }

    // Score each result
    const scored: RankedResult[] = [];
    for (let i = 0; i < results.length; i++) {
      const resultVector = vectors[i + 1];
      if (!resultVector) continue;
      const score = cosineSimilarity(subjectVector, resultVector);
      if (score >= minScore) {
        scored.push({ result: results[i]!, score });
      }
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);
    const ranked = scored.slice(0, topN);

    logInfo("Re-ranking complete", {
      node: "reranker",
      traceId,
      researchId: subject,
    });

    return ranked;
  });
}
