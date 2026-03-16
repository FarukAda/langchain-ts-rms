import { tool } from "@langchain/core/tools";
import type { RmsToolDeps } from "../types.js";
import { DeleteResearchInputSchema, coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse, getResearchOrThrow } from "../helpers.js";
import { logError, ErrorCodes } from "../../infra/observability/tracing.js";

/**
 * Creates the `rms_delete_research` tool.
 * Deletes a research entry by its UUID.
 */
export function createDeleteResearchTool(deps: RmsToolDeps) {
  return tool(
    async (rawInput) => {
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const researchId = input["researchId"] as string;
        // Verify it exists first
        await getResearchOrThrow(deps.researchRepository, researchId);
        await deps.researchRepository.deleteByIds([researchId]);
        return wrapToolResponse({
          deleted: true,
          researchId,
        });
      } catch (err) {
        logError("rms_delete_research failed", {
          errorCode: ErrorCodes.RESEARCH_NOT_FOUND,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "rms_delete_research",
      description:
        "Delete a specific research entry from the cache by its UUID. The entry is permanently removed. Use this to clean up outdated or irrelevant research data.",
      schema: DeleteResearchInputSchema,
    },
  );
}
