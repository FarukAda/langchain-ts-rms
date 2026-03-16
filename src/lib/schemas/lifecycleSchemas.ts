import { z } from "zod/v4";
import { laxInt } from "./researchSchemas.js";

/* -------------------------------------------------------------------------- */
/*  Runtime coercion helper                                                   */
/*                                                                            */
/*  LLMs sometimes send booleans as strings ("true"/"false", "1"/"0",         */
/*  "yes"/"no") and numbers as strings ("100") or even "null".                */
/*  This helper normalizes the raw input BEFORE Zod schema parsing so that    */
/*  the JSON Schema–safe schemas can still accept messy LLM output.           */
/* -------------------------------------------------------------------------- */

const BOOL_TRUE = new Set(["true", "1", "yes", "on"]);
const BOOL_FALSE = new Set(["false", "0", "no", "off"]);

const BOOL_FIELDS = new Set(["forceRefresh", "force_refresh"]);
const INT_FIELDS = new Set(["maxResults", "max_results", "limit", "offset"]);
const ARRAY_FIELDS = new Set(["status", "tags"]);

/**
 * Coerce LLM-sent string booleans / string numbers in raw tool input.
 * Returns a shallow copy with coerced values; the original is not mutated.
 *
 * Apply to tool inputs containing laxBool / laxInt fields. Tools whose
 * schemas only declare uuid / string inputs can skip this.
 */
export function coerceLifecycleInput<T extends Record<string, unknown>>(raw: T): T {
  const out: Record<string, unknown> = { ...raw };

  for (const key of Object.keys(out)) {
    const val = out[key];

    // Treat the string "null" the same as actual null
    if (val === "null") {
      out[key] = null;
      continue;
    }

    // Coerce string values for array fields
    if (ARRAY_FIELDS.has(key) && typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed === "" || trimmed === "undefined") {
        out[key] = undefined;
      } else {
        out[key] = [trimmed];
      }
      continue;
    }

    // Clean array fields that contain "null" strings or empty strings
    if (ARRAY_FIELDS.has(key) && Array.isArray(val)) {
      const cleaned = (val as unknown[]).filter((v) => v !== null && v !== "null" && v !== "");
      out[key] = cleaned.length > 0 ? cleaned : undefined;
      continue;
    }

    // Coerce string booleans
    if (BOOL_FIELDS.has(key) && typeof val === "string") {
      const s = val.toLowerCase().trim();
      if (BOOL_TRUE.has(s)) out[key] = true;
      else if (BOOL_FALSE.has(s)) out[key] = false;
      continue;
    }

    // Coerce string integers
    if (INT_FIELDS.has(key) && typeof val === "string") {
      const n = Number(val);
      out[key] = Number.isFinite(n) ? Math.trunc(n) : undefined;
      continue;
    }
  }

  return out as T;
}

// ── Lifecycle schemas ──

export const GetResearchInputSchema = z
  .object({
    researchId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "The UUID of the research entry to retrieve" }),
    research_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for researchId" }),
    id: z.string().min(1).nullable().optional().meta({ description: "Alias for researchId" }),
  })
  .refine((data) => !!(data.researchId ?? data.research_id ?? data.id), {
    message: "One of researchId, research_id, or id must be provided",
  });

export const ListResearchInputSchema = z.object({
  status: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional()
    .meta({
      description: "Filter by status(es): active, stale, refreshing, archived, low_confidence",
      examples: ["active", ["active", "stale"]],
    }),
  tenantId: z.string().nullable().optional().meta({ description: "Filter by tenant ID" }),
  tenant_id: z.string().nullable().optional().meta({ description: "Alias for tenantId" }),
  limit: laxInt
    .nullable()
    .optional()
    .meta({
      description: "Maximum number of results to return. Defaults to 20.",
      examples: [10, 20, 50],
    }),
  offset: laxInt
    .nullable()
    .optional()
    .meta({
      description: "Offset for pagination. Defaults to 0.",
      examples: [0, 20, 40],
    }),
});

export const SearchResearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .meta({ description: "Semantic search query to find relevant research entries" }),
  tenantId: z.string().nullable().optional().meta({ description: "Filter by tenant ID" }),
  tenant_id: z.string().nullable().optional().meta({ description: "Alias for tenantId" }),
  tags: z
    .union([z.array(z.string()), z.string()])
    .nullable()
    .optional()
    .meta({ description: "Filter by tags" }),
  limit: laxInt
    .nullable()
    .optional()
    .meta({ description: "Maximum number of results. Defaults to 5." }),
});

export const DeleteResearchInputSchema = z
  .object({
    researchId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "The UUID of the research entry to delete" }),
    research_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for researchId" }),
    id: z.string().min(1).nullable().optional().meta({ description: "Alias for researchId" }),
  })
  .refine((data) => !!(data.researchId ?? data.research_id ?? data.id), {
    message: "One of researchId, research_id, or id must be provided",
  });

export const GetDateTimeInputSchema = z
  .object({})
  .describe("No input required. Returns the current date, time, and timezone.");

export const RefreshResearchInputSchema = z
  .object({
    researchId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "The UUID of the research entry to force-refresh" }),
    research_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for researchId" }),
    id: z.string().min(1).nullable().optional().meta({ description: "Alias for researchId" }),
    maxResults: laxInt
      .nullable()
      .optional()
      .meta({ description: "Maximum search results to process during refresh. Defaults to 10." }),
    max_results: laxInt.nullable().optional().meta({ description: "Alias for maxResults" }),
  })
  .refine((data) => !!(data.researchId ?? data.research_id ?? data.id), {
    message: "One of researchId, research_id, or id must be provided",
  });
