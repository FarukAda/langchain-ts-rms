import { z } from "zod/v4";

/** Research entry status in the lifecycle */
export const ResearchStatusSchema = z.enum([
  "active",
  "stale",
  "refreshing",
  "archived",
  "low_confidence",
]);
export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;

/** Response contract version stamped on all RMS tool outputs. */
export const RESPONSE_CONTRACT_VERSION = "1.0";

/** Per-source summary stored in a Research entry. */
export const SourceSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  keyTakeaways: z.string(),
  relevance: z.number().min(0).max(1).default(0.5),
  tags: z.array(z.string()).default([]),
  language: z.string().default("en"),
});
export type SourceSummaryEntry = z.infer<typeof SourceSummarySchema>;

/** Research entry — the core domain object for RMS. */
export const ResearchSchema = z.object({
  id: z.uuid(),
  subject: z.string().min(1),
  summary: z.string().min(1),
  sourceSummaries: z.array(SourceSummarySchema).default([]),
  sourceUrls: z.array(z.string()).default([]),
  searchQueries: z.array(z.string()).default([]),
  /**
   * Timestamps use ISO 8601 with timezone offset.
   *
   * Design note: These intentionally allow future dates:
   * - `expiresAt` is always in the future (freshness window)
   * - `createdAt` / `updatedAt` are system-generated, not user input
   * - Adding `max: now()` would break deserialization under clock skew
   *   or when reading entries created on a different host
   */
  createdAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  status: ResearchStatusSchema.default("active"),
  confidenceScore: z.number().min(0).max(1).default(0.5),
  sourceCount: z.number().int().min(0).default(0),
  tenantId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  language: z.string().default("en"),
  rawResultCount: z.number().int().min(0).default(0),
  keyFindings: z.array(z.string()).optional(),
  limitations: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Research = z.infer<typeof ResearchSchema>;
