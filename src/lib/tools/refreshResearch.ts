import { tool } from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { RmsToolDeps } from "../types.js";
import { RefreshResearchInputSchema, coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse, getResearchOrThrow } from "../helpers.js";
import { buildWorkflowDeps } from "./research.js";
import { createRmsWorkflow } from "../../app/graph/workflow.js";
import { logError, logInfo, ErrorCodes } from "../../infra/observability/tracing.js";

/**
 * Creates the `rms_refresh_research` tool.
 * Force-refreshes a specific research entry: re-runs the full RMS workflow
 * (web search, query rewriting, re-ranking, summarization, confidence gating)
 * and replaces the old entry.
 */
export function createRefreshResearchTool(deps: RmsToolDeps) {
  // Lazily compile the workflow to avoid startup overhead and allow unit tests
  // with shallow mocks (workflow is compiled on first invocation and reused).
  let _workflow: ReturnType<typeof createRmsWorkflow> | undefined;
  function getWorkflow() {
    if (!_workflow) {
      _workflow = createRmsWorkflow(buildWorkflowDeps(deps));
    }
    return _workflow;
  }

  return tool(
    async (rawInput) => {
      // Extract researchId before try so it's available in catch for HITL response
      const rawResearchId =
        (rawInput as Record<string, unknown>)["researchId"] ??
        (rawInput as Record<string, unknown>)["research_id"] ??
        "";
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const researchId = input["researchId"] as string;
        const maxResults = (input["maxResults"] as number | undefined) ?? 10;

        // Fetch existing entry to get the subject
        const existing = await getResearchOrThrow(deps.researchRepository, researchId);

        // Invoke the full workflow with forceRefresh=true
        const finalState = await getWorkflow().invoke(
          {
            subject: existing.subject,
            tenantId: existing.tenantId,
            forceRefresh: true,
            maxResults,
          },
          {
            configurable: {
              thread_id: (input["threadId"] as string | undefined) ?? crypto.randomUUID(),
            },
          },
        );

        // Check for workflow-level errors
        if (finalState.error) {
          return wrapToolResponse({ error: finalState.error });
        }

        return wrapToolResponse({
          research: finalState.research,
          source: finalState.source,
          wasRefreshed: true,
          previousResearchId: researchId,
        });
      } catch (err) {
        // HITL: guardrail-triggered interrupt → structured response
        if (isGraphInterrupt(err)) {
          logInfo("rms_refresh_research: human approval required (graph interrupt)");
          return wrapToolResponse({
            status: "human_approval_required",
            researchId: rawResearchId as string,
            interrupts: (err as { interrupts?: unknown[] }).interrupts ?? [],
          });
        }

        logError("rms_refresh_research failed", {
          errorCode: ErrorCodes.SEARCH_FAILED,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: "rms_refresh_research",
      description:
        "Force-refresh a specific research entry by its UUID. Fetches the entry, re-runs web search for its subject, re-summarizes the results, deletes the old entry, and stores the new one. Use this when you know a specific research entry is outdated and needs immediate updating.",
      schema: RefreshResearchInputSchema,
    },
  );
}
