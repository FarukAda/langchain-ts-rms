import { z } from "zod/v4";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { logInfo, logWarn, withNodeTiming } from "../../infra/observability/tracing.js";

/**
 * Schema for the LLM structured output when planning search queries.
 */
export const QueryPlanOutputSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .max(4)
    .meta({
      description:
        "2-4 diverse, optimized keyword search queries designed to retrieve the best web results " +
        "for the given research subject. Each query should approach the topic from a different angle: " +
        "one broad, one specific/technical, and optionally one using alternative terminology.",
      examples: [
        ["LangGraph state management best practices", "LangGraph StateGraph TypeScript tutorial"],
        ["React server components vs client components", "Next.js RSC architecture 2025"],
      ],
    }),
});

export type QueryPlanOutput = z.infer<typeof QueryPlanOutputSchema>;

const SYSTEM_PROMPT = `You are a search query optimization expert. Your queries feed into SearXNG for an automated research pipeline.

Before generating, consider: what sub-topics exist, and what alternative terminology could improve coverage?

Guidelines:
1. Generate 2-4 keyword-focused search queries optimized for web search engines.
2. Use specific keywords with technical terms, version numbers, or product names when relevant.
3. Cover different angles: broad overview, specific/technical, and alternative terminology.
4. Prefer queries that return documentation, tutorials, or authoritative sources.

Example — subject: "How to handle state in LangGraph"
  Good: "LangGraph StateGraph state management best practices", "LangGraph TypeScript checkpointer persistence tutorial 2025"
  Bad (just rephrasing): "how to handle state in LangGraph"`;

/**
 * Generates optimized search queries from a natural language research subject.
 *
 * Converts conversational or vague subjects into 2-4 diverse keyword queries
 * that are optimized for web search engines (SearXNG). This dramatically
 * improves search result quality compared to passing raw subjects as queries.
 */
export async function planSearchQueries(
  subject: string,
  chatModel: BaseChatModel,
  traceId?: string,
): Promise<string[]> {
  return withNodeTiming("queryPlanner", traceId, subject, async () => {
    logInfo("Planning search queries", {
      node: "queryPlanner",
      traceId,
      researchId: subject,
    });

    const humanMsg =
      `Research subject:\n<subject>\n${subject}\n</subject>\n\n` +
      `Generate 2-4 optimized search queries for this research subject.`;

    try {
      const structuredModel = chatModel.withStructuredOutput(QueryPlanOutputSchema, {
        method: "jsonSchema",
        name: "query_plan",
      });

      const result = await structuredModel.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(humanMsg),
      ]);

      const queries = result.queries.map((q) => q.trim()).filter((q) => q.length > 0);

      logInfo("Search queries planned", {
        node: "queryPlanner",
        traceId,
        researchId: subject,
        queryCount: queries.length,
      });

      return queries.length > 0 ? queries : [subject];
    } catch (err) {
      // On failure, fall back to using the raw subject as the search query
      logWarn("Query planning failed, using raw subject", {
        node: "queryPlanner",
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [subject];
    }
  });
}
