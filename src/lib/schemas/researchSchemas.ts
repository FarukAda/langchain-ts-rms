import { z } from "zod/v4";

/* -------------------------------------------------------------------------- */
/*  JSON Schema–safe lax types                                                */
/*                                                                            */
/*  These schemas avoid `.transform()` which Zod v4's `toJSONSchema()`        */
/*  refuses to serialize. LLM string coercion happens in                      */
/*  `coerceLifecycleInput()` BEFORE schema parsing so the proper branch       */
/*  of each union matches.                                                    */
/* -------------------------------------------------------------------------- */

/** Boolean that also accepts string representations (JSON Schema compat). */
export const laxBool = z.union([z.boolean(), z.string()]);

/** Integer that also accepts string representations (JSON Schema compat). */
export const laxInt = z.union([z.number().int(), z.string()]);

/** Float that also accepts string representations (JSON Schema compat). */
export const laxFloat = z.union([z.number(), z.string()]);

// ── Main research tool input schema ──

export const RmsResearchInputSchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({
        title: "subject",
        description: "The research topic or question to investigate",
        examples: ["latest trends in AI safety", "React server components best practices"],
      }),
    topic: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for subject — the research topic" }),
    query: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for subject — the research query" }),
    question: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .meta({ description: "Alias for subject — the research question" }),
    tenantId: z
      .string()
      .nullable()
      .optional()
      .meta({ description: "Optional tenant ID for multi-tenancy isolation" }),
    tenant_id: z.string().nullable().optional().meta({ description: "Alias for tenantId" }),
    forceRefresh: laxBool
      .nullable()
      .optional()
      .meta({
        description: "Force re-research even if cached data is fresh. Defaults to false.",
        examples: [false, true],
      }),
    force_refresh: laxBool.nullable().optional().meta({ description: "Alias for forceRefresh" }),
    maxResults: laxInt
      .nullable()
      .optional()
      .meta({
        description: "Maximum number of web search results to process. Defaults to 10.",
        examples: [5, 10, 20],
      }),
    max_results: laxInt.nullable().optional().meta({ description: "Alias for maxResults" }),
    metadata: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .meta({ description: "Optional extra metadata to attach to the research entry" }),
    traceId: z
      .string()
      .nullable()
      .optional()
      .meta({ description: "Optional trace ID for observability correlation" }),
  })
  .refine((data) => !!(data.subject ?? data.topic ?? data.query ?? data.question), {
    message: "At least one of subject, topic, query, or question must be provided",
  });

export type RmsResearchInput = z.infer<typeof RmsResearchInputSchema>;
