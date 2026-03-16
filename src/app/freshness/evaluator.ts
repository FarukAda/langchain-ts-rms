import type { Research } from "../../domain/contracts.js";
import type { IResearchRepository } from "../../domain/ports.js";
import { isResearchFresh, getResearchAge, getResearchAgeDays } from "../../domain/researchUtils.js";
import { logInfo, logDebug } from "../../infra/observability/tracing.js";

export interface FreshnessResult {
  isFresh: boolean;
  cachedResearch: Research | null;
  staleness: "fresh" | "stale" | "missing";
  cacheAge?: number;
  cacheAgeDays?: number;
  score?: number;
}

/**
 * Evaluates whether existing cached research for a subject is still fresh.
 *
 * Returns:
 * - `fresh` — cached data exists and has not expired
 * - `stale` — cached data exists but has expired
 * - `missing` — no cached data found for this subject
 */
export async function evaluateFreshness(
  subject: string,
  repository: IResearchRepository,
  opts?: { tenantId?: string | undefined; now?: Date | undefined },
): Promise<FreshnessResult> {
  const now = opts?.now ?? new Date();

  logDebug("Evaluating freshness", { node: "evaluateFreshness", researchId: subject });

  // Semantic search (vector similarity)
  const results = await repository.findBySubject(subject, {
    tenantId: opts?.tenantId,
    k: 1,
  });

  // Enhanced retrieval: if semantic search returns low-confidence results,
  // retry with tenant filter to catch cases where unfiltered search
  // returned low confidence (both paths use vector similarity — Qdrant
  // does not support keyword/BM25 search)
  //
  // Use a strict threshold (0.85) because vector similarity yields >0.6 even
  // for completely unrelated sentences. A lower threshold allows conceptually
  // distinct subjects (e.g. "quantum computing" vs "typescript 5.5") to falsely match,
  // which can cause destructive overwrites during forceRefresh.
  let bestResult = results[0];
  if (!bestResult || bestResult.score < 0.85) {
    logDebug("Low semantic score, retrying with tenant filter", {
      node: "evaluateFreshness",
      researchId: subject,
      semanticScore: bestResult?.score,
    });
    const keywordResults = await repository.search(subject, {
      k: 1,
      filter: {
        tenantId: opts?.tenantId,
      },
    });
    const keywordBest = keywordResults[0];
    // Use keyword result if it's better or if semantic returned nothing
    if (keywordBest && (!bestResult || keywordBest.score > bestResult.score)) {
      bestResult = keywordBest;
    }
  }

  if (!bestResult) {
    logInfo("No cached research found", {
      node: "evaluateFreshness",
      researchId: subject,
    });
    return { isFresh: false, cachedResearch: null, staleness: "missing" };
  }

  const { research, score } = bestResult;
  const fresh = isResearchFresh(research, now);
  const cacheAge = getResearchAge(research, now);
  const cacheAgeDays = getResearchAgeDays(research, now);

  logInfo("Freshness evaluated", {
    node: "evaluateFreshness",
    researchId: research.id,
    durationMs: cacheAge,
  });

  return {
    isFresh: fresh,
    cachedResearch: research,
    staleness: fresh ? "fresh" : "stale",
    cacheAge,
    cacheAgeDays,
    score,
  };
}
