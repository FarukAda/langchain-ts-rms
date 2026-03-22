import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { Document } from "@langchain/core/documents";
import { QdrantVectorStore } from "@langchain/qdrant";
import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Research } from "../../domain/contracts.js";
import { ResearchSchema } from "../../domain/contracts.js";
import type {
  IResearchRepository,
  ResearchSearchFilter,
  ResearchListOptions,
  ResearchListResult,
} from "../../domain/ports.js";
import { RESEARCH_COLLECTION, createQdrantClient } from "./qdrantClient.js";
import { logInfo, logWarn, logDebug } from "../observability/tracing.js";
import { sanitizeNumericValues } from "../../lib/helpers.js";

// Re-export port types for backward compatibility
export type {
  ResearchSearchFilter,
  ResearchListOptions,
  ResearchListResult,
} from "../../domain/ports.js";
export type { IResearchRepository } from "../../domain/ports.js";

// ---------- helpers ----------

/**
 * Maximum characters to embed as pageContent.
 * nomic-embed-text has an 8192-token context window (~4 chars/token).
 * We use 24K chars (~6K tokens) to stay safely within limits.
 */
const MAX_EMBED_CHARS = 24_000;

function researchToDocument(research: Research): Document {
  // Sanitize all numeric values in the payload to prevent Qdrant's Go REST
  // layer from rejecting NaN/Infinity with "json: unsupported value: NaN".
  const metadata = sanitizeNumericValues({
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
  });
  return {
    pageContent: research.summary.slice(0, MAX_EMBED_CHARS),
    metadata,
  };
}

function documentToResearch(doc: Document): Research | null {
  const m = doc.metadata as Record<string, unknown>;
  const candidate = {
    id: m["research_id"],
    subject: m["subject"],
    summary: doc.pageContent,
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
  };
  const result = ResearchSchema.safeParse(candidate);
  if (!result.success) {
    logWarn(
      `documentToResearch: Invalid data for id=${String(m["research_id"])}: ${result.error.message}`,
    );
    return null;
  }
  return result.data;
}

function filterToQdrantFilter(filter?: ResearchSearchFilter): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  const must: Record<string, unknown>[] = [];
  if (filter.tenantId) {
    must.push({ key: "metadata.tenant_id", match: { value: filter.tenantId } });
  }
  if (filter.status?.length) {
    must.push({
      key: "metadata.status",
      match: { any: filter.status },
    });
  }
  if (filter.tags?.length) {
    must.push({
      key: "metadata.tags",
      match: { any: filter.tags },
    });
  }
  return must.length > 0 ? { must } : undefined;
}

// ---------- repository ----------

export class ResearchRepository implements IResearchRepository {
  private readonly store: QdrantVectorStore;
  private readonly client: QdrantClient;
  private readonly collectionName: string;

  constructor(config: {
    embeddings: EmbeddingsInterface;
    collectionName?: string;
    client?: QdrantClient;
  }) {
    this.collectionName = config.collectionName ?? RESEARCH_COLLECTION;
    this.client = config.client ?? createQdrantClient();
    this.store = new QdrantVectorStore(config.embeddings, {
      client: this.client,
      collectionName: this.collectionName,
    });
  }

  async upsert(research: Research): Promise<void> {
    const doc = researchToDocument(research);
    await this.store.addDocuments([doc], { ids: [research.id] });
    logInfo("Research upserted", { researchId: research.id });
  }

  async search(
    query: string,
    opts?: { k?: number; filter?: ResearchSearchFilter },
  ): Promise<Array<{ research: Research; score: number }>> {
    const k = opts?.k ?? 5;
    const filter = filterToQdrantFilter(opts?.filter);
    const results = await this.store.similaritySearchWithScore(query, k, filter);
    const mapped: Array<{ research: Research; score: number }> = [];
    for (const [doc, score] of results) {
      const research = documentToResearch(doc);
      if (research) mapped.push({ research, score });
    }
    return mapped;
  }

  async getById(researchId: string): Promise<Research | null> {
    const result = await this.client.scroll(this.collectionName, {
      filter: {
        must: [{ key: "metadata.research_id", match: { value: researchId } }],
      },
      limit: 1,
      with_payload: true,
      with_vector: false,
    });
    const points = result.points;
    if (points.length === 0) return null;
    const point = points[0]!;
    return pointToResearch(point);
  }

  async list(options?: ResearchListOptions): Promise<ResearchListResult> {
    const safeLimit = Math.max(1, Math.min(200, options?.limit ?? 20));
    const safeOffset = Math.max(0, options?.offset ?? 0);
    const qdrantFilter = filterToQdrantFilter({
      tenantId: options?.tenantId,
      status: options?.status,
    });

    // O(1) count — no data transfer, uses Qdrant count endpoint
    const countResult = await this.client.count(this.collectionName, {
      ...(qdrantFilter ? { filter: qdrantFilter } : {}),
      exact: true,
    });
    const total = countResult.count;

    // Determine the scroll cursor:
    // 1. If a cursor is provided (from a previous nextCursor), use it directly (O(1))
    // 2. Otherwise fall back to the O(n) offset-skipping loop for backward compat
    let cursor: string | number | null | undefined;
    if (options?.cursor) {
      // Parse the cursor — it's a stringified Qdrant point ID
      cursor = options.cursor;
    } else if (safeOffset > 0) {
      // Skip `offset` points via scroll cursor without loading payload.
      //
      // ⚠️ O(n) trade-off: Qdrant's scroll API has no native offset parameter,
      // so we must page through discarded batches.  For typical RMS workloads
      // (≤ hundreds of entries) this is negligible.  For very large offsets,
      // use cursor-based pagination via the `cursor` option instead.
      let skipped = 0;
      while (skipped < safeOffset) {
        const batch = Math.min(200, safeOffset - skipped);
        const page = await this.client.scroll(this.collectionName, {
          ...(qdrantFilter ? { filter: qdrantFilter } : {}),
          limit: batch,
          ...(cursor !== undefined ? { offset: cursor } : {}),
          with_payload: false,
          with_vector: false,
        });
        const points = page.points ?? [];
        if (points.length === 0) break;
        skipped += points.length;
        const next = (page as { next_page_offset?: string | number | null }).next_page_offset;
        if (next === undefined || next === null) break;
        cursor = next;
      }
    }

    // Fetch the actual page with payload
    const dataPage = await this.client.scroll(this.collectionName, {
      ...(qdrantFilter ? { filter: qdrantFilter } : {}),
      limit: safeLimit,
      ...(cursor !== undefined ? { offset: cursor } : {}),
      with_payload: true,
      with_vector: false,
    });

    const items = (dataPage.points ?? [])
      .map(pointToResearch)
      .filter((r): r is Research => r !== null);

    // Extract next_page_offset for cursor-based pagination
    const rawNextCursor = (dataPage as { next_page_offset?: string | number | null })
      .next_page_offset;
    const nextCursor = rawNextCursor != null ? String(rawNextCursor) : undefined;

    logDebug("Research list", {
      total,
      offset: safeOffset,
      limit: safeLimit,
      returned: items.length,
      hasCursor: !!options?.cursor,
      hasNextCursor: !!nextCursor,
    });

    return {
      items,
      total,
      limit: safeLimit,
      offset: safeOffset,
      nextCursor,
    };
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(this.collectionName, {
      filter: {
        must: [{ key: "metadata.research_id", match: { any: ids } }],
      },
    });
    logInfo("Research entries deleted", { deletedIds: ids.join(",") });
  }

  async findBySubject(
    subject: string,
    opts?: { tenantId?: string | undefined; k?: number | undefined },
  ): Promise<Array<{ research: Research; score: number }>> {
    return this.search(subject, {
      k: opts?.k ?? 5,
      filter: { tenantId: opts?.tenantId },
    });
  }

  async findStale(
    now: Date,
    opts?: { tenantId?: string | undefined; limit?: number | undefined },
  ): Promise<Research[]> {
    const filter: Record<string, unknown>[] = [
      { key: "metadata.status", match: { value: "active" } },
    ];
    if (opts?.tenantId) {
      filter.push({ key: "metadata.tenant_id", match: { value: opts.tenantId } });
    }
    const scrollParams: Parameters<QdrantClient["scroll"]>[1] = {
      limit: opts?.limit ?? 100,
      with_payload: true,
      with_vector: false,
    };
    if (filter.length > 0) scrollParams.filter = { must: filter };
    const result = await this.client.scroll(this.collectionName, scrollParams);
    return result.points
      .map(pointToResearch)
      .filter((r): r is Research => r !== null)
      .filter((r) => {
        if (!r.expiresAt) return true;
        return new Date(r.expiresAt).getTime() <= now.getTime();
      });
  }
}

/**
 * Converts a raw Qdrant scroll point to a Research domain object.
 * LangChain's QdrantVectorStore stores:
 *   - Document pageContent as `content` in the Qdrant payload
 *   - Document metadata under `metadata` in the Qdrant payload
 */
function pointToResearch(point: { payload?: Record<string, unknown> | null }): Research | null {
  const payload = point.payload ?? {};
  const m = (payload["metadata"] ?? {}) as Record<string, unknown>;
  const candidate = {
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
  };
  const result = ResearchSchema.safeParse(candidate);
  if (!result.success) {
    logWarn(
      `pointToResearch: Invalid data for id=${String(m["research_id"])}: ${result.error.message}`,
    );
    return null;
  }
  return result.data;
}
