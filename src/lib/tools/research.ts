import { tool } from "@langchain/core/tools";
import { isGraphInterrupt } from "@langchain/langgraph";
import type { RmsToolDeps } from "../types.js";
import { RmsResearchInputSchema } from "../schemas/researchSchemas.js";
import type { RmsResearchInput } from "../schemas/researchSchemas.js";
import { coerceLifecycleInput } from "../schemas/lifecycleSchemas.js";
import { stripNulls, normalizeInput, wrapToolResponse } from "../helpers.js";
import { createRmsWorkflow, RMS_NODE_NAMES, type WorkflowDeps } from "../../app/graph/workflow.js";
import type { Research } from "../../domain/contracts.js";
import type { ExtractionDetail } from "../../app/summarization/summarizer.js";
import { logError, logInfo, ErrorCodes } from "../../infra/observability/tracing.js";

// ---------------------------------------------------------------------------
// Workflow Types & Cache
// ---------------------------------------------------------------------------

/** The compiled workflow type returned by `createRmsWorkflow`. */
type CompiledRmsWorkflow = ReturnType<typeof createRmsWorkflow>;

/** WeakMap cache: reuse compiled workflows across calls with the same deps object. */
const workflowCache = new WeakMap<object, CompiledRmsWorkflow>();

function getOrCreateWorkflow(
  deps: Omit<RmsToolDeps, "toolName" | "toolDescription">,
): CompiledRmsWorkflow {
  let workflow = workflowCache.get(deps);
  if (!workflow) {
    workflow = createRmsWorkflow(buildWorkflowDeps(deps));
    workflowCache.set(deps, workflow);
  }
  return workflow;
}

/**
 * Maps `RmsToolDeps` → `WorkflowDeps`, stripping tool-only fields
 * (`toolName`, `toolDescription`) that the graph doesn't need.
 */
export function buildWorkflowDeps(
  deps: Omit<RmsToolDeps, "toolName" | "toolDescription">,
): WorkflowDeps {
  return {
    researchRepository: deps.researchRepository,
    ...(deps.checkpointer != null && { checkpointer: deps.checkpointer }),
    ...(deps.chatModel != null && { chatModel: deps.chatModel }),
    ...(deps.embeddings != null && { embeddings: deps.embeddings }),
    ...(deps.freshnessDays != null && { freshnessDays: deps.freshnessDays }),
    ...(deps.onResearchComplete != null && { onResearchComplete: deps.onResearchComplete }),
    ...(deps.onApprovalRequired != null && { onApprovalRequired: deps.onApprovalRequired }),
    ...(deps.onCacheHit != null && { onCacheHit: deps.onCacheHit }),
  };
}

// ---------------------------------------------------------------------------
// Typed Streaming Events
// ---------------------------------------------------------------------------

/** Event types emitted during research streaming. */
export type RmsEventType =
  | "FRESHNESS_CHECK_START"
  | "FRESHNESS_CHECK_COMPLETE"
  | "GUARDRAIL_START"
  | "GUARDRAIL_COMPLETE"
  | "QUERY_PLANNING_START"
  | "QUERY_PLANNING_COMPLETE"
  | "SEARCH_START"
  | "SEARCH_COMPLETE"
  | "QUERY_REWRITING_START"
  | "QUERY_REWRITING_COMPLETE"
  | "RERANKING_START"
  | "RERANKING_COMPLETE"
  | "HUMAN_APPROVAL_REQUIRED"
  | "SUMMARIZATION_START"
  | "SUMMARIZATION_COMPLETE"
  | "PERSIST_START"
  | "PERSIST_COMPLETE"
  | "RESEARCH_COMPLETE"
  | "RESEARCH_ERROR";

/** Structured event yielded by `streamResearch`. */
export interface RmsEvent {
  type: RmsEventType;
  data?: unknown;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Service-Layer APIs
// ---------------------------------------------------------------------------

/**
 * Service-layer API: invoke the RMS workflow directly without wrapping in
 * a LangChain tool. Mirrors GMS's `createPlanWithWorkflow()` pattern.
 *
 * Uses WeakMap-cached compiled workflow to avoid repeated graph compilation.
 */
export async function conductResearchDirect(
  input: RmsResearchInput,
  deps: Omit<RmsToolDeps, "toolName" | "toolDescription">,
  options?: { threadId?: string },
): Promise<
  | { research: Research; source: string; wasRefreshed: boolean }
  | {
      error: string;
      interrupted?: boolean;
      extractionBreakdown?: ExtractionDetail[] | undefined;
      confidence?: number | undefined;
    }
> {
  const workflow = getOrCreateWorkflow(deps);
  // Coerce nullable schema values to workflow-expected types
  const subject = input.subject ?? input.topic ?? input.query ?? input.question ?? "";

  try {
    const finalState = await workflow.invoke(
      {
        subject,
        tenantId: input.tenantId ?? undefined,
        forceRefresh: Boolean(input.forceRefresh ?? false),
        maxResults: Number(input.maxResults ?? 10),
        traceId: input.traceId ?? undefined,
        metadata: input.metadata ?? undefined,
      },
      { configurable: { thread_id: options?.threadId ?? crypto.randomUUID() } },
    );

    if (finalState.error) {
      return { error: finalState.error };
    }

    // Guard: if the workflow was interrupted (e.g. human approval) without
    // throwing, the state will have research=undefined and no error.
    if (!finalState.research) {
      return {
        error: "Research requires human approval (confidence below threshold)",
        interrupted: true,
        extractionBreakdown: finalState.summarization?.extractionBreakdown,
        confidence: finalState.summarization?.overallConfidence,
      };
    }

    return {
      research: finalState.research,
      source: finalState.source,
      wasRefreshed: !!finalState.cachedResearch,
    };
  } catch (err) {
    // HITL: confidence-gated interrupt from the human_approval node
    if (isGraphInterrupt(err)) {
      logInfo("conductResearchDirect: human approval required (graph interrupt)", {
        subject,
      });
      return {
        error: "Research interrupted: human approval required",
        interrupted: true,
      };
    }
    throw err;
  }
}

/**
 * Streaming API: yields typed `RmsEvent` objects from the RMS workflow.
 *
 * Uses LangGraph's `streamEvents` (v2) under the hood, mapping internal
 * graph transitions to typed RMS events. Consumers can pipe these over
 * SSE, WebSockets, or any async channel.
 *
 * Uses WeakMap-cached compiled workflow to avoid repeated graph compilation.
 *
 * @example
 * ```ts
 * for await (const event of streamResearch(input, deps)) {
 *   console.log(event.type, event.data);
 * }
 * ```
 */
export async function* streamResearch(
  input: RmsResearchInput,
  deps: Omit<RmsToolDeps, "toolName" | "toolDescription">,
  options?: { threadId?: string },
): AsyncGenerator<RmsEvent> {
  const workflow = getOrCreateWorkflow(deps);
  const subject = input.subject ?? input.topic ?? input.query ?? input.question ?? "";
  const now = () => new Date().toISOString();

  try {
    const stream = workflow.streamEvents(
      {
        subject,
        tenantId: input.tenantId ?? undefined,
        forceRefresh: Boolean(input.forceRefresh ?? false),
        maxResults: Number(input.maxResults ?? 10),
        traceId: input.traceId ?? undefined,
        metadata: input.metadata ?? undefined,
      },
      { configurable: { thread_id: options?.threadId ?? crypto.randomUUID() }, version: "v2" },
    );

    for await (const event of stream) {
      const mapped = mapStreamEvent(event, subject);
      if (mapped) yield mapped;
    }

    yield { type: "RESEARCH_COMPLETE", data: { subject }, timestamp: now() };
  } catch (err) {
    if (isGraphInterrupt(err)) {
      yield {
        type: "HUMAN_APPROVAL_REQUIRED",
        data: { subject, interrupt: (err as { interrupts?: unknown[] }).interrupts?.[0] },
        timestamp: now(),
      };
      yield { type: "RESEARCH_COMPLETE", data: { subject }, timestamp: now() };
      return;
    }
    yield {
      type: "RESEARCH_ERROR",
      data: { subject, error: err instanceof Error ? err.message : String(err) },
      timestamp: now(),
    };
  }
}

/** Name-to-event-type mapping for start events. */
const START_EVENT_MAP: Partial<Record<string, RmsEventType>> = {
  [RMS_NODE_NAMES.FRESHNESS_CHECKER]: "FRESHNESS_CHECK_START",
  [RMS_NODE_NAMES.GUARDRAIL]: "GUARDRAIL_START",
  [RMS_NODE_NAMES.QUERY_PLANNER]: "QUERY_PLANNING_START",
  [RMS_NODE_NAMES.SEARCHER]: "SEARCH_START",
  [RMS_NODE_NAMES.QUERY_REWRITER]: "QUERY_REWRITING_START",
  [RMS_NODE_NAMES.RERANKER]: "RERANKING_START",
  [RMS_NODE_NAMES.HUMAN_APPROVAL]: "HUMAN_APPROVAL_REQUIRED",
  [RMS_NODE_NAMES.SUMMARIZER]: "SUMMARIZATION_START",
  [RMS_NODE_NAMES.PERSISTER]: "PERSIST_START",
};

/** Name-to-event-type mapping for end events. */
const END_EVENT_MAP: Partial<Record<string, RmsEventType>> = {
  [RMS_NODE_NAMES.FRESHNESS_CHECKER]: "FRESHNESS_CHECK_COMPLETE",
  [RMS_NODE_NAMES.GUARDRAIL]: "GUARDRAIL_COMPLETE",
  [RMS_NODE_NAMES.QUERY_PLANNER]: "QUERY_PLANNING_COMPLETE",
  [RMS_NODE_NAMES.SEARCHER]: "SEARCH_COMPLETE",
  [RMS_NODE_NAMES.QUERY_REWRITER]: "QUERY_REWRITING_COMPLETE",
  [RMS_NODE_NAMES.RERANKER]: "RERANKING_COMPLETE",
  [RMS_NODE_NAMES.SUMMARIZER]: "SUMMARIZATION_COMPLETE",
  [RMS_NODE_NAMES.PERSISTER]: "PERSIST_COMPLETE",
};

/** Maps a LangGraph v2 stream event to a typed RmsEvent (returns null for unmapped events). */
function mapStreamEvent(
  event: { event: string; name?: string; data?: unknown },
  subject: string,
): RmsEvent | null {
  const now = new Date().toISOString();

  switch (event.event) {
    case "on_chain_start": {
      const type = event.name ? START_EVENT_MAP[event.name] : undefined;
      if (type) return { type, data: { subject }, timestamp: now };
      return null;
    }
    case "on_chain_end": {
      const type = event.name ? END_EVENT_MAP[event.name] : undefined;
      if (type) return { type, data: { subject, output: event.data }, timestamp: now };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Creates the main `rms_research` tool.
 *
 * This tool invokes the full RMS LangGraph workflow which:
 * 1. Checks Qdrant for fresh cached research
 * 2. If stale/missing → searches the web via SearXNG
 * 3. Evaluates query relevance and rewrites if needed (agentic RAG loop)
 * 4. Re-ranks results by semantic similarity
 * 5. Summarizes via LLM with structured output
 * 6. Applies confidence gating
 * 7. Persists the new research entry in Qdrant
 */
export function createResearchTool(deps: RmsToolDeps) {
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
      // Extract subject before try so it's available in catch for HITL response
      const rawSubject =
        (rawInput as Record<string, unknown>)["subject"] ??
        (rawInput as Record<string, unknown>)["topic"] ??
        (rawInput as Record<string, unknown>)["query"] ??
        (rawInput as Record<string, unknown>)["question"] ??
        "";
      try {
        const input = normalizeInput(stripNulls(coerceLifecycleInput(rawInput)));
        const subject = (input["subject"] as string) || (rawSubject as string);

        const finalState = await getWorkflow().invoke(
          {
            subject,
            tenantId: input["tenantId"] as string | undefined,
            forceRefresh: (input["forceRefresh"] as boolean | undefined) ?? false,
            maxResults: (input["maxResults"] as number | undefined) ?? 10,
            traceId: input["traceId"] as string | undefined,
            metadata: input["metadata"] as Record<string, unknown> | undefined,
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

        // Guard: if the workflow was interrupted (e.g. human approval) without
        // throwing, the state will have research=undefined and no error.
        if (!finalState.research) {
          logInfo("rms_research: human approval required (no research in final state)");
          return wrapToolResponse({
            status: "human_approval_required",
            subject: rawSubject as string,
          });
        }

        return wrapToolResponse({
          research: finalState.research,
          source: finalState.source,
          wasRefreshed: !!finalState.cachedResearch,
        });
      } catch (err) {
        // HITL: guardrail-triggered interrupt → structured response
        if (isGraphInterrupt(err)) {
          logInfo("rms_research: human approval required (graph interrupt)");
          return wrapToolResponse({
            status: "human_approval_required",
            subject: rawSubject as string,
            interrupts: (err as { interrupts?: unknown[] }).interrupts ?? [],
          });
        }

        logError("rms_research failed", {
          errorCode: ErrorCodes.SEARCH_FAILED,
          error: err instanceof Error ? err.message : String(err),
        });
        return wrapToolResponse({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    {
      name: deps.toolName ?? "rms_research",
      description:
        deps.toolDescription ??
        "Research a topic thoroughly. Checks the RAG cache for fresh existing data (< 7 days old). If stale or missing, generates optimized search queries, runs concurrent web searches via SearXNG, semantically reranks and deduplicates results, extracts full page content, extracts key takeaways from each source via individual LLM calls, synthesizes a comprehensive report, and stores it in the cache. Use this tool whenever you need factual, up-to-date information on any topic. Provide the subject/topic as input.",
      schema: RmsResearchInputSchema,
    },
  );
}
