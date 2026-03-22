import { RESPONSE_CONTRACT_VERSION } from "../domain/contracts.js";
import type { Research } from "../domain/contracts.js";
import type { IResearchRepository } from "../domain/ports.js";
import { ErrorCodes, logWarn } from "../infra/observability/tracing.js";

/**
 * Recursively replaces `null` values with `undefined`.
 * LLMs frequently send null where optional fields are expected.
 */
export function stripNulls<T>(obj: T): T {
  if (obj === null || obj === undefined) return undefined as unknown as T;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripNulls) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = v === null ? undefined : stripNulls(v);
  }
  return out as T;
}

/**
 * Resolves alias fields for the research input (subject/topic/query/question).
 */
export function normalizeInput(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  // Resolve subject aliases
  if (!out["subject"]) {
    out["subject"] = out["topic"] ?? out["query"] ?? out["question"];
  }
  // Resolve tenantId aliases
  if (!out["tenantId"]) {
    out["tenantId"] = out["tenant_id"];
  }
  // Resolve forceRefresh aliases
  if (out["forceRefresh"] === undefined && out["force_refresh"] !== undefined) {
    out["forceRefresh"] = out["force_refresh"];
  }
  // Resolve maxResults aliases
  if (out["maxResults"] === undefined && out["max_results"] !== undefined) {
    out["maxResults"] = out["max_results"];
  }
  // Resolve researchId aliases
  if (!out["researchId"]) {
    out["researchId"] = out["research_id"] ?? out["id"];
  }
  return out;
}

/**
 * Simple offset/limit pagination helper.
 */
export function paginate<T>(items: T[], limit: number, offset: number): T[] {
  return items.slice(offset, offset + limit);
}

/**
 * Wraps tool output in a versioned JSON response.
 */
export function wrapToolResponse(data: Record<string, unknown>): string {
  return JSON.stringify({ version: RESPONSE_CONTRACT_VERSION, ...data });
}

/**
 * Recursively replaces `NaN` and `Infinity` with a safe fallback (default: `0`).
 *
 * JavaScript's `JSON.stringify` silently converts `NaN`/`Infinity` to `null`,
 * but Qdrant's Go-based REST layer rejects payloads containing non-finite
 * numbers with `"json: unsupported value: NaN"`. This sanitizer prevents
 * that boundary failure.
 */
export function sanitizeNumericValues(
  value: Record<string, unknown>,
  fallback = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = sanitizeValue(v, fallback);
  }
  return out;
}

function sanitizeValue(value: unknown, fallback: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (Array.isArray(value)) return value.map((item: unknown) => sanitizeValue(item, fallback));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(v, fallback);
    }
    return out;
  }
  return value;
}

/**
 * Fetches a research entry by ID or throws a domain error.
 */
export async function getResearchOrThrow(
  repo: IResearchRepository,
  researchId: string,
): Promise<Research> {
  const research = await repo.getById(researchId);
  if (!research) {
    logWarn("Research not found", { errorCode: ErrorCodes.RESEARCH_NOT_FOUND, researchId });
    throw new Error(`Research entry not found: ${researchId}`);
  }
  return research;
}

/**
 * Predicate for filtering research entries by status and tenant.
 */
export function matchesFilters(research: Research, status?: string[], tenantId?: string): boolean {
  if (status?.length && !status.includes(research.status)) return false;
  if (tenantId && research.tenantId !== tenantId) return false;
  return true;
}

/**
 * Summarizes accumulated token usage from a workflow run.
 * Returns total tokens and a human-readable breakdown string.
 */
export function summarizeTokenUsage(usage: { promptTokens: number; completionTokens: number }): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  summary: string;
} {
  const totalTokens = usage.promptTokens + usage.completionTokens;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens,
    summary: `${totalTokens} tokens (${usage.promptTokens} prompt + ${usage.completionTokens} completion)`,
  };
}
