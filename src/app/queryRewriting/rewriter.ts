import { z } from "zod/v4";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { SearxngSearchResult } from "../../infra/search/searxngClient.js";
import { logInfo, logDebug, logWarn, withNodeTiming } from "../../infra/observability/tracing.js";

/** Maximum number of query rewrites before forcing summarization. */
export const MAX_REWRITES = 2;

/** Minimum relevance score below which a rewrite is triggered. */
export const MIN_RELEVANCE_SCORE = 0.4;

/**
 * Schema for the LLM structured output when evaluating query relevance.
 */
export const QueryRewriteOutputSchema = z.object({
  isRelevant: z.boolean().meta({
    description:
      "Whether the search results are sufficiently relevant to the research subject. " +
      "True if the results contain substantial information addressing the subject. " +
      "False if the results are mostly irrelevant, off-topic, or too sparse.",
  }),
  relevanceScore: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .meta({
      description:
        "A score from 0.0 to 1.0 indicating how relevant the search results are to the subject. " +
        "0.0 = completely irrelevant, 1.0 = perfectly relevant.",
      examples: [0.2, 0.5, 0.8],
    }),
  rewrittenQuery: z
    .string()
    .optional()
    .meta({
      description:
        "If the results are not relevant, provide a rewritten version of the search query " +
        "that might produce better results. Use more specific terms, add context, or rephrase. " +
        "Only set this if isRelevant is false.",
    }),
  reasoning: z.string().meta({
    description:
      "Brief explanation of why the results are or are not relevant, " +
      "and what the rewritten query aims to improve.",
  }),
});

export type QueryRewriteOutput = z.infer<typeof QueryRewriteOutputSchema>;

const SYSTEM_PROMPT = `You are a search quality evaluator in an automated research pipeline. Your assessment determines whether to proceed or retry with a better query.

Before scoring, consider: do results directly address the subject, and are the sources substantive?

Guidelines:
1. Assess whether results directly address the research subject.
2. Consider both coverage (breadth) and quality (source reliability, depth).
3. If insufficient, provide a rewritten query with more specific or clarifying terms.
4. Score based on actual content quality, not surface-level keyword matches.

Example — Subject: "Rust async runtime comparison", results mostly about Rust basics
  → relevanceScore: 0.15, rewrittenQuery: "tokio vs async-std vs smol Rust async runtime benchmark 2025"`;

export interface QueryRewriteResult {
  isRelevant: boolean;
  relevanceScore: number;
  rewrittenQuery?: string | undefined;
  reasoning: string;
}

/**
 * Evaluates the relevance of search results to the subject and optionally
 * rewrites the query for better results.
 *
 * Used as a feedback loop node in the LangGraph workflow:
 * searcher → queryRewriter → (relevant? summarizer : searcher with rewritten query)
 */
export async function evaluateQueryRelevance(
  subject: string,
  searchResults: SearxngSearchResult[],
  chatModel: BaseChatModel,
  traceId?: string,
): Promise<QueryRewriteResult> {
  return withNodeTiming("queryRewriter", traceId, subject, async () => {
    logDebug("Evaluating search result relevance", {
      node: "queryRewriter",
      traceId,
      researchId: subject,
    });

    const resultsPreview = searchResults
      .slice(0, 5) // Only send top-5 to reduce tokens
      .map((r, i) => `[${String(i + 1)}] ${r.title}\n${r.snippet}`)
      .join("\n\n");

    const humanMsg =
      `Research subject:\n<subject>\n${subject}\n</subject>\n\n` +
      `Search results (${String(searchResults.length)} total, showing top 5):\n<search_results>\n${resultsPreview}\n</search_results>\n\n` +
      `Evaluate the relevance of these results to the research subject.`;

    try {
      const structuredModel = chatModel.withStructuredOutput(QueryRewriteOutputSchema, {
        method: "jsonSchema",
        name: "query_relevance_evaluation",
      });
      const result = await structuredModel.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(humanMsg),
      ]);

      const relevanceScore = Math.min(1, Math.max(0, result.relevanceScore ?? 0.5));
      const isRelevant = result.isRelevant && relevanceScore >= MIN_RELEVANCE_SCORE;

      logInfo("Query relevance evaluated", {
        node: "queryRewriter",
        traceId,
        researchId: subject,
      });

      return {
        isRelevant,
        relevanceScore,
        rewrittenQuery: isRelevant ? undefined : result.rewrittenQuery,
        reasoning: result.reasoning,
      };
    } catch (err) {
      // On evaluation failure, assume results are relevant to avoid blocking
      logWarn("Query relevance evaluation failed, assuming relevant", {
        node: "queryRewriter",
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        isRelevant: true,
        relevanceScore: 0.5,
        reasoning: "Evaluation failed; proceeding with current results.",
      };
    }
  });
}
