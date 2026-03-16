import { tool } from "@langchain/core/tools";
import type { RmsToolDeps } from "../types.js";
import { ListResearchInputSchema, coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse } from "../helpers.js";
import type { ResearchStatus } from "../../domain/contracts.js";
import { logError, ErrorCodes } from "../../infra/observability/tracing.js";

/**
 * Creates the `rms_list_research` tool.
 * Lists research entries with optional filtering by status and tenant, with pagination.
 */
export function createListResearchTool(deps: RmsToolDeps) {
  return tool(
    async (rawInput) => {
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const result = await deps.researchRepository.list({
          status: input["status"] as ResearchStatus[] | undefined,
          tenantId: input["tenantId"] as string | undefined,
          limit: (input["limit"] as number | undefined) ?? 20,
          offset: (input["offset"] as number | undefined) ?? 0,
        });
        return wrapToolResponse({
          items: result.items,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        });
      } catch (err) {
        logError("rms_list_research failed", {
          errorCode: ErrorCodes.INFRA_RETRIABLE,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "rms_list_research",
      description:
        "List research entries stored in the cache. Supports filtering by status (active, stale, refreshing, archived), tenant ID, and pagination via limit/offset. Use this to browse or audit stored research.",
      schema: ListResearchInputSchema,
    },
  );
}
