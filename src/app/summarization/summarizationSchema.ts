import { z } from "zod/v4";

/**
 * Schema for structured LLM output when summarizing ONE search result.
 * Used with `chatModel.withStructuredOutput(SourceSummaryOutputSchema)`.
 *
 * Each search result gets its own LLM call with this schema,
 * keeping the task focused and the context small for reliable extraction.
 */
export const SourceSummaryOutputSchema = z.object({
  keyTakeaways: z
    .string()
    .min(300)
    .meta({
      description:
        "8-15 detailed sentences extracting the most important facts, techniques, and insights from this specific source. " +
        "Be concrete — include names, version numbers, code patterns, configuration values, and actionable details. " +
        "Each sentence MUST convey a distinct fact. Cover all noteworthy information in the source.",
      examples: [
        "LangGraph v0.2 introduced the StateGraph API which replaces the legacy MessageGraph for stateful agent orchestration. " +
          "The checkpointer interface supports pluggable backends including MemorySaver for development and PostgresSaver for production persistence.",
      ],
    }),
  relevance: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .meta({
      description:
        "How relevant this source is to the research subject. " +
        "0.7-1.0: directly on topic. 0.4-0.7: partially relevant. 0.0-0.3: off-topic or irrelevant.",
      examples: [0.3, 0.7, 0.95],
    }),
  tags: z
    .array(z.string())
    .default([])
    .meta({
      description:
        "1 to 3 topic tags extracted from this specific source. E.g. ['typescript', 'node-js'].",
      examples: [
        ["typescript", "best-practices"],
        ["react", "hooks"],
      ],
    }),
  language: z
    .string()
    .default("en")
    .meta({
      description: "ISO 639-1 language code of this source. E.g. 'en', 'de', 'nl'.",
      examples: ["en", "de", "nl", "fr"],
    }),
});

export type SourceSummaryOutput = z.infer<typeof SourceSummaryOutputSchema>;

/**
 * Schema for batched structured LLM output when summarizing ALL search results
 * in a single call. Each element in the `sources` array corresponds to one
 * search result, in order.
 *
 * @deprecated No longer used internally — the summarizer now processes
 * one source per LLM call using {@link SourceSummaryOutputSchema}.
 * Kept for backward compatibility of the public export surface.
 */
export const BatchSummaryOutputSchema = z.object({
  sources: z.array(SourceSummaryOutputSchema).meta({
    description:
      "An array of summaries, one per source in the order they were provided. " +
      "Each element contains the key takeaways, relevance score, tags, and language for that source.",
  }),
});

export type BatchSummaryOutput = z.infer<typeof BatchSummaryOutputSchema>;
