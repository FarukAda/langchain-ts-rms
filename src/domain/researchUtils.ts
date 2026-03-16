import type { Research, SourceSummaryEntry } from "./contracts.js";

/**
 * Checks whether a research entry is still fresh (not expired).
 * A research entry is fresh if its `expiresAt` timestamp is in the future.
 */
export function isResearchFresh(research: Research, now?: Date): boolean {
  if (!research.expiresAt) return false;
  const currentTime = now ?? new Date();
  return new Date(research.expiresAt).getTime() > currentTime.getTime();
}

/**
 * Calculates the expiration timestamp by adding `freshnessDays` to the given date.
 */
export function calculateExpiresAt(updatedAt: string, freshnessDays: number): string {
  const date = new Date(updatedAt);
  date.setDate(date.getDate() + freshnessDays);
  return date.toISOString();
}

/**
 * Builds a human-readable composite summary from per-source summaries.
 * Filters out low-relevance sources (< 0.3) so the summary stays useful.
 */
export function buildCompositeSummary(sources: SourceSummaryEntry[]): string {
  if (sources.length === 0) return "No sources available.";
  const relevant = sources.filter((s) => s.relevance >= 0.3);
  if (relevant.length === 0) return "No sufficiently relevant sources found.";
  return relevant.map((s) => `**${s.title}**\n${s.keyTakeaways}\n[Source: ${s.url}]`).join("\n\n");
}

/**
 * Constructs a new Research domain object with sensible defaults.
 *
 * When `sourceSummaries` is provided, the composite `summary` is
 * auto-generated from per-source takeaways (unless an explicit
 * `summary` override is also given).
 */
export function buildResearch(input: {
  subject: string;
  sourceSummaries?: SourceSummaryEntry[] | undefined;
  summary?: string | undefined;
  sourceUrls?: string[] | undefined;
  searchQueries?: string[] | undefined;
  confidenceScore?: number | undefined;
  tags?: string[] | undefined;
  language?: string | undefined;
  rawResultCount?: number | undefined;
  keyFindings?: string[] | undefined;
  limitations?: string[] | undefined;
  tenantId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  freshnessDays?: number | undefined;
}): Research {
  const now = new Date().toISOString();
  const freshnessDays = input.freshnessDays ?? 7;
  const sourceSummaries = input.sourceSummaries ?? [];
  const summary = input.summary ?? buildCompositeSummary(sourceSummaries);
  return {
    id: crypto.randomUUID(),
    subject: input.subject,
    summary,
    sourceSummaries,
    sourceUrls: input.sourceUrls ?? [],
    searchQueries: input.searchQueries ?? [],
    createdAt: now,
    updatedAt: now,
    expiresAt: calculateExpiresAt(now, freshnessDays),
    status: "active",
    confidenceScore: input.confidenceScore ?? 0.5,
    sourceCount: input.sourceUrls?.length ?? 0,
    tenantId: input.tenantId,
    tags: input.tags ?? [],
    language: input.language ?? "en",
    rawResultCount: input.rawResultCount ?? 0,
    keyFindings: input.keyFindings,
    limitations: input.limitations,
    metadata: input.metadata ?? {},
  };
}

/**
 * Merges incoming metadata with existing metadata (shallow merge).
 */
export function mergeResearchMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...incoming };
}

/**
 * Returns the age of a research entry in milliseconds.
 */
export function getResearchAge(research: Research, now?: Date): number {
  const currentTime = now ?? new Date();
  const updatedAt = research.updatedAt ? new Date(research.updatedAt) : new Date(0);
  return currentTime.getTime() - updatedAt.getTime();
}

/**
 * Returns the age of a research entry in days.
 */
export function getResearchAgeDays(research: Research, now?: Date): number {
  return getResearchAge(research, now) / (1000 * 60 * 60 * 24);
}
