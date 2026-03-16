import { tool } from "@langchain/core/tools";
import type { RmsToolDeps } from "../types.js";
import { GetResearchInputSchema, coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse, getResearchOrThrow } from "../helpers.js";
import { logError, ErrorCodes } from "../../infra/observability/tracing.js";

/**
 * Creates the `rms_get_research` tool.
 * Retrieves a single research entry by its UUID.
 */
export function createGetResearchTool(deps: RmsToolDeps) {
  return tool(
    async (rawInput) => {
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const researchId = input["researchId"] as string;
        const research = await getResearchOrThrow(deps.researchRepository, researchId);
        return wrapToolResponse({ research });
      } catch (err) {
        logError("rms_get_research failed", {
          errorCode: ErrorCodes.RESEARCH_NOT_FOUND,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "rms_get_research",
      description:
        "Retrieve a specific research entry by its UUID. Returns the full research object including summary, sources, metadata, and freshness status. Use this when you already have a research ID and want to view its full details.",
      schema: GetResearchInputSchema,
    },
  );
}
