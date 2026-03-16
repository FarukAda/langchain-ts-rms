import type { Research, ResearchStatus } from "./contracts.js";

/** Payload filter options for searching research entries. */
export interface ResearchSearchFilter {
  tenantId?: string | undefined;
  status?: ResearchStatus[] | undefined;
  tags?: string[] | undefined;
}

/** Paging and filter options for listing research entries. */
export interface ResearchListOptions {
  tenantId?: string | undefined;
  status?: ResearchStatus[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Opaque cursor from a previous list() call. Takes precedence over offset. */
  cursor?: string | undefined;
}

/** Deterministic page payload with total count metadata. */
export interface ResearchListResult {
  items: Research[];
  total: number;
  limit: number;
  offset: number;
  /** Opaque cursor for fetching the next page. Undefined if no more pages. */
  nextCursor?: string | undefined;
}

/**
 * Storage-agnostic repository contract for research persistence.
 *
 * Implement this interface to plug in any vector store backend
 * (Qdrant, Pinecone, pgvector, in-memory, etc.).
 */
export interface IResearchRepository {
  /** Upsert a research entry into the store. */
  upsert(research: Research): Promise<void>;

  /** Semantic search with optional payload filters. */
  search(
    query: string,
    opts?: { k?: number; filter?: ResearchSearchFilter },
  ): Promise<Array<{ research: Research; score: number }>>;

  /** Retrieve a research entry by ID (exact match). */
  getById(researchId: string): Promise<Research | null>;

  /** List research entries with server-side pagination and optional filters. */
  list(options?: ResearchListOptions): Promise<ResearchListResult>;

  /** Delete research entries by IDs. */
  deleteByIds(ids: string[]): Promise<void>;

  /** Find research entries by subject using semantic similarity. */
  findBySubject(
    subject: string,
    opts?: { tenantId?: string | undefined; k?: number | undefined },
  ): Promise<Array<{ research: Research; score: number }>>;

  /** Find stale (expired) research entries. */
  findStale(
    now: Date,
    opts?: { tenantId?: string | undefined; limit?: number | undefined },
  ): Promise<Research[]>;
}
