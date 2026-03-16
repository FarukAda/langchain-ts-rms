import { tool } from "@langchain/core/tools";
import type { RmsToolDeps } from "../types.js";
import { SearchResearchInputSchema, coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse } from "../helpers.js";
import { logError, ErrorCodes } from "../../infra/observability/tracing.js";

/**
 * Creates the `rms_search_research` tool.
 * Performs semantic search across stored research entries using vector similarity.
 */
export function createSearchResearchTool(deps: RmsToolDeps) {
  return tool(
    async (rawInput) => {
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const query = input["query"] as string;
        const limit = (input["limit"] as number | undefined) ?? 5;
        const results = await deps.researchRepository.search(query, {
          k: limit,
          filter: {
            tenantId: input["tenantId"] as string | undefined,
            tags: input["tags"] as string[] | undefined,
          },
        });
        return wrapToolResponse({
          results: results.map((r) => ({
            research: r.research,
            score: r.score,
          })),
          total: results.length,
        });
      } catch (err) {
        logError("rms_search_research failed", {
          errorCode: ErrorCodes.INFRA_RETRIABLE,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "rms_search_research",
      description:
        "Semantically search across all stored research entries using natural language. Returns research entries ranked by relevance along with similarity scores. Use this when you have a broad question and want to find the most relevant existing research.",
      schema: SearchResearchInputSchema,
    },
  );
}
