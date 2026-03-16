import {
  StateGraph,
  START,
  END,
  interrupt,
  MemorySaver,
  type BaseCheckpointSaver,
  type GraphNode,
  type ConditionalEdgeRouter,
} from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";

import { RmsStateAnnotation } from "../state/schema.js";
import { evaluateFreshness } from "../freshness/evaluator.js";
import { checkGuardrail } from "../governance/guardrails.js";
import { summarizeSearchResults } from "../summarization/summarizer.js";
import { synthesizeSummary } from "../summarization/synthesizer.js";
import { evaluateQueryRelevance, MAX_REWRITES } from "../queryRewriting/rewriter.js";
import { rerankSearchResults } from "../reranking/reranker.js";
import { planSearchQueries } from "../queryPlanning/planner.js";
import { performSearch } from "../../infra/search/searxngClient.js";
import { buildResearch, buildCompositeSummary } from "../../domain/researchUtils.js";
import type { IResearchRepository } from "../../domain/ports.js";
import type { Research } from "../../domain/contracts.js";
import { createChatModelProvider } from "../../infra/chat/chatModelProvider.js";
import { createEmbeddingProvider } from "../../infra/embeddings/embeddingProvider.js";
import type { TokenUsageCollector } from "../../infra/observability/tokenCounter.js";

import {
  logInfo,
  logWarn,
  logError,
  ErrorCodes,
  withNodeTiming,
} from "../../infra/observability/tracing.js";

/** Canonical node name constants used by both the graph and event mapping. */
export const RMS_NODE_NAMES = {
  FRESHNESS_CHECKER: "freshnessChecker",
  GUARDRAIL: "guardrail",
  QUERY_PLANNER: "queryPlanner",
  SEARCHER: "searcher",
  QUERY_REWRITER: "queryRewriter",
  RERANKER: "reranker",
  HUMAN_APPROVAL: "human_approval",
  SUMMARIZER: "summarizer",
  PERSISTER: "persister",
} as const;

export interface WorkflowDeps {
  researchRepository: IResearchRepository;

  /** Inject for testing; otherwise uses createChatModelProvider() */
  chatModel?: BaseChatModel | undefined;
  /** Inject for testing; otherwise uses createEmbeddingProvider() */
  embeddings?: EmbeddingsInterface | undefined;
  /** Default freshness threshold in days */
  freshnessDays?: number | undefined;
  /**
   * Inject a checkpointer; defaults to MemorySaver (in-memory, not for production).
   * For production, use `@langchain/langgraph-checkpoint-sqlite` or
   * `@langchain/langgraph-checkpoint-postgres`.
   */
  checkpointer?: BaseCheckpointSaver;

  // --- Execution hooks ---
  /** Fired when new research is successfully persisted. */
  onResearchComplete?: (research: Research) => void | Promise<void>;
  /** Fired when the workflow requires human approval. */
  onApprovalRequired?: (subject: string, confidence: number) => void | Promise<void>;
  /** Fired when a fresh cached research entry is returned. */
  onCacheHit?: (research: Research) => void | Promise<void>;

  /**
   * Token usage collector for accumulating LLM token counts.
   * When provided, the persister node writes final usage into state.
   */
  tokenCollector?: TokenUsageCollector;
}

/**
 * Builds the RMS LangGraph workflow:
 * freshnessChecker -> (conditional) -> searcher -> summarizer -> persister
 *
 * RMS produces research summaries for autonomous agents.
 * Guardrail gating and HITL interrupt are supported for sensitive queries.
 */
export function createRmsWorkflow(deps: WorkflowDeps) {
  const rawChatModel = deps.chatModel ?? createChatModelProvider();
  const embeddings = deps.embeddings ?? createEmbeddingProvider();

  // Wire token usage tracking: withConfig binds the collector as a callback
  // so every LLM invocation (including withStructuredOutput) feeds usage metadata.
  // The cast is safe because RunnableBinding forwards all calls to the underlying model.
  const chatModel = (
    deps.tokenCollector
      ? rawChatModel.withConfig({ callbacks: [deps.tokenCollector] })
      : rawChatModel
  ) as BaseChatModel;

  const checkpointer =
    deps.checkpointer ??
    (() => {
      const msg =
        "No durable checkpointer provided — using in-memory MemorySaver. " +
        "State will be lost on process restart and HITL resume will not work.\n" +
        "For production, inject a checkpointer via deps.checkpointer:\n" +
        "  import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';\n" +
        "  const checkpointer = SqliteSaver.fromConnString('rms.db');\n" +
        "See: https://langchain-ai.github.io/langgraphjs/reference/classes/checkpoint_sqlite.SqliteSaver.html";
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(msg);
      }
      logWarn(msg);
      return new MemorySaver();
    })();

  const graph = new StateGraph(RmsStateAnnotation)
    .addNode("freshnessChecker", freshnessCheckerNode(deps), {
      retryPolicy: { maxAttempts: 3 },
    })
    .addNode("guardrail", guardrailNode())
    .addNode("queryPlanner", queryPlannerNode(chatModel))
    .addNode("searcher", searcherNode(), {
      retryPolicy: { maxAttempts: 3 },
    })
    .addNode("queryRewriter", queryRewriterNode(chatModel))
    .addNode("reranker", rerankerNode(embeddings))
    .addNode("human_approval", humanApprovalNode(deps, checkpointer))
    .addNode("summarizer", summarizerNode(chatModel), {
      retryPolicy: { maxAttempts: 3 },
    })
    .addNode("persister", persisterNode(deps))
    .addEdge(START, "freshnessChecker")
    .addConditionalEdges("freshnessChecker", routeAfterFreshness, {
      guardrail: "guardrail",
      persister: "persister",
    })
    .addConditionalEdges("guardrail", routeAfterGuardrail, {
      queryPlanner: "queryPlanner",
      persister: "persister",
    })
    .addEdge("queryPlanner", "searcher")
    .addEdge("searcher", "queryRewriter")
    .addConditionalEdges("queryRewriter", routeAfterQueryRewriter, {
      searcher: "searcher",
      reranker: "reranker",
    })
    .addEdge("reranker", "summarizer")
    .addConditionalEdges("summarizer", routeAfterSummarizer, {
      human_approval: "human_approval",
      persister: "persister",
    })
    .addEdge("human_approval", "persister")
    .addEdge("persister", END);

  return graph.compile({ checkpointer });
}

// ── Node Implementations ─────────────────────────────────────────────

function freshnessCheckerNode(deps: WorkflowDeps) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, traceId, tenantId } = state;
    return withNodeTiming("freshnessChecker", traceId, subject, async () => {
      logInfo("Checking freshness", { node: "freshnessChecker", researchId: subject, traceId });

      const freshness = await evaluateFreshness(subject, deps.researchRepository, { tenantId });

      return {
        cachedResearch: freshness.cachedResearch ?? undefined,
        isFresh: freshness.isFresh,
        currentPhase: "freshness" as const,
      };
    });
  };
  return node;
}

/**
 * Guards the subject against forbidden patterns before search.
 * Sets `error` if blocked, which causes downstream routing to skip search.
 */
function guardrailNode() {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, traceId } = state;
    return withNodeTiming("guardrail", traceId, subject, () => {
      const check = checkGuardrail(subject);
      if (!check.allowed) {
        logWarn("Guardrail blocked research", {
          node: "guardrail",
          researchId: subject,
          reason: check.reason,
        });
        return { error: check.reason };
      }
      logInfo("Guardrail passed", { node: "guardrail", researchId: subject });
      return {};
    });
  };
  return node;
}

/**
 * Generates optimized search queries from the subject before searching.
 */
function queryPlannerNode(chatModel: BaseChatModel) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, traceId } = state;
    return withNodeTiming("queryPlanner", traceId, subject, async () => {
      const queries = await planSearchQueries(subject, chatModel, traceId);
      return {
        plannedQueries: queries,
        currentPhase: "queryPlanning" as const,
      };
    });
  };
  return node;
}

/**
 * Executes web searches for all planned queries concurrently,
 * merging and deduplicating results by URL.
 *
 * When a rewritten query is available (from the query rewriter loop),
 * it takes precedence over planned queries.
 */
function searcherNode() {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, traceId, maxResults, rewrittenQuery, originalSubject, plannedQueries } = state;
    return withNodeTiming("searcher", traceId, subject, async () => {
      try {
        // Determine which queries to execute
        const queries = rewrittenQuery
          ? [rewrittenQuery]
          : plannedQueries.length > 0
            ? plannedQueries
            : [subject];

        logInfo("Searching web", {
          node: "searcher",
          researchId: subject,
          traceId,
          queryCount: queries.length,
        });

        // Execute all queries concurrently
        const perQueryLimit = Math.max(3, Math.ceil(maxResults / queries.length));
        const allResults = await Promise.all(
          queries.map((q) =>
            performSearch(q, { numResults: perQueryLimit }).catch((err) => {
              logWarn("Individual query search failed", {
                node: "searcher",
                query: q,
                error: err instanceof Error ? err.message : String(err),
              });
              return [];
            }),
          ),
        );

        // Merge and deduplicate by URL, keeping the first occurrence
        const seen = new Set<string>();
        const searchResults = allResults.flat().filter((r) => {
          if (seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        });

        return {
          searchResults: searchResults.slice(0, maxResults),
          currentPhase: "searching" as const,
          // Preserve original subject on first search
          originalSubject: originalSubject ?? subject,
        };
      } catch (err) {
        // Degraded mode: return empty results with error instead of throwing
        logError("Search failed, entering degraded mode", {
          node: "searcher",
          researchId: subject,
          traceId,
          errorCode: ErrorCodes.SEARCH_FAILED,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          searchResults: [],
          error: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          currentPhase: "searching" as const,
          originalSubject: originalSubject ?? subject,
        };
      }
    });
  };
  return node;
}

/**
 * Evaluates relevance of search results and rewrites the query if needed.
 * Loops back to searcher when relevance is low and rewrites are available.
 */
function queryRewriterNode(chatModel: BaseChatModel) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, searchResults, traceId, rewriteCount } = state;
    return withNodeTiming("queryRewriter", traceId, subject, async () => {
      const result = await evaluateQueryRelevance(subject, searchResults, chatModel, traceId);

      return {
        relevanceScore: result.relevanceScore,
        rewrittenQuery: result.isRelevant ? undefined : result.rewrittenQuery,
        rewriteCount: result.isRelevant ? rewriteCount : rewriteCount + 1,
        currentPhase: "queryRewriting" as const,
      };
    });
  };
  return node;
}

/**
 * Re-ranks search results by semantic similarity to the subject.
 * Filters out low-relevance results before summarization.
 */
function rerankerNode(embeddings: EmbeddingsInterface) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, searchResults, traceId } = state;
    return withNodeTiming("reranker", traceId, subject, async () => {
      const ranked = await rerankSearchResults(
        subject,
        searchResults,
        embeddings,
        { topN: 10 },
        traceId,
      );

      return {
        searchResults: ranked.map((r) => r.result),
        currentPhase: "reranking" as const,
      };
    });
  };
  return node;
}

function summarizerNode(chatModel: BaseChatModel) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, searchResults, traceId } = state;
    return withNodeTiming("summarizer", traceId, subject, async () => {
      try {
        logInfo("Summarizing", { node: "summarizer", researchId: subject, traceId });

        const summarization = await summarizeSearchResults(subject, searchResults, chatModel);

        // Synthesis step: produce a unified research report from per-source takeaways
        try {
          const synthesis = await synthesizeSummary(
            subject,
            summarization.sourceSummaries,
            chatModel,
          );
          summarization.synthesizedSummary = synthesis.synthesizedSummary;
          summarization.keyFindings = synthesis.keyFindings;
          summarization.limitations = synthesis.limitations;

          logInfo("Synthesis complete", {
            node: "summarizer",
            researchId: subject,
            traceId,
            summaryLength: synthesis.synthesizedSummary.length,
            keyFindingsCount: synthesis.keyFindings.length,
          });
        } catch (synthErr) {
          // Synthesis is non-fatal — fall back to composite summary
          logWarn("Synthesis failed, using per-source composite summary", {
            node: "summarizer",
            researchId: subject,
            traceId,
            error: synthErr instanceof Error ? synthErr.message : String(synthErr),
          });
        }

        // Token usage is captured automatically via the TokenUsageCollector
        // callback wired at graph construction (chatModel.withConfig({ callbacks })).
        // LangChain fires handleLLMEnd at the LLM layer before withStructuredOutput
        // post-processing, so token counts accumulate correctly.
        return {
          summarization,
          currentPhase: "summarizing" as const,
        };
      } catch (err) {
        // Degraded mode: persist raw results without summarization
        logError("Summarization failed, persisting raw results", {
          node: "summarizer",
          researchId: subject,
          traceId,
          errorCode: ErrorCodes.SUMMARIZATION_FAILED,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          summarization: {
            sourceSummaries: searchResults.map((r) => ({
              url: r.url,
              title: r.title,
              keyTakeaways: r.snippet,
              relevance: 0.1,
              tags: [],
              language: "en",
            })),
            overallConfidence: 0.1,
            tags: [],
            language: "en",
            extractionBreakdown: [],
          },
          currentPhase: "summarizing" as const,
        };
      }
    });
  };
  return node;
}

function persisterNode(deps: WorkflowDeps) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const {
      subject,
      traceId,
      cachedResearch,
      searchResults,
      summarization,
      error,
      tenantId,
      metadata,
      plannedQueries,
    } = state;
    return withNodeTiming("persister", traceId, subject, async () => {
      // If error occurred upstream, skip persistence
      if (error) {
        logError("Skipping persistence due to upstream error", {
          node: "persister",
          researchId: subject,
          error,
        });
        return { currentPhase: "persisting" as const };
      }

      // If returning cached result (isFresh path), just set source
      if (!summarization) {
        if (deps.onCacheHit && cachedResearch) {
          try {
            await deps.onCacheHit(cachedResearch);
          } catch {
            /* non-fatal: consumer hook */
          }
        }
        return {
          research: cachedResearch,
          source: "cache" as const,
          currentPhase: "persisting" as const,
          tokenUsage: deps.tokenCollector?.usage ?? { promptTokens: 0, completionTokens: 0 },
        };
      }

      // Delete stale entry before inserting new one
      if (cachedResearch) {
        await deps.researchRepository.deleteByIds([cachedResearch.id]);
      }

      const freshnessDays = deps.freshnessDays ?? state.freshnessDays;

      // Filter out dead sources (relevance === 0 or empty URL)
      const cleanSummaries = summarization.sourceSummaries.filter(
        (s) => s.url.length > 0 && s.relevance > 0,
      );

      // Use synthesis if available and substantial; otherwise fall back to composite
      const synthesisText = summarization.synthesizedSummary?.trim();
      const MIN_SYNTHESIS_LENGTH = 200;
      const summary =
        synthesisText && synthesisText.length >= MIN_SYNTHESIS_LENGTH
          ? synthesisText
          : buildCompositeSummary(cleanSummaries);

      // Use planned queries (if available) instead of just the subject
      const storedQueries =
        plannedQueries.length > 0 ? [...new Set([subject, ...plannedQueries])] : [subject];

      const research = buildResearch({
        subject,
        sourceSummaries: cleanSummaries,
        summary,
        sourceUrls: searchResults.map((r) => r.url).filter(Boolean),
        searchQueries: storedQueries,
        confidenceScore: summarization.overallConfidence,
        tags: summarization.tags,
        language: summarization.language,
        rawResultCount: searchResults.length,
        keyFindings: summarization.keyFindings,
        limitations: summarization.limitations,
        tenantId,
        metadata,
        freshnessDays,
      });

      await deps.researchRepository.upsert(research);

      if (deps.onResearchComplete) {
        try {
          await deps.onResearchComplete(research);
        } catch {
          /* non-fatal: consumer hook */
        }
      }

      logInfo("Research persisted", { node: "persister", researchId: research.id, traceId });

      return {
        research,
        source: cachedResearch ? ("cache+web" as const) : ("web" as const),
        currentPhase: "persisting" as const,
        tokenUsage: deps.tokenCollector?.usage ?? { promptTokens: 0, completionTokens: 0 },
      };
    });
  };
  return node;
}

/** Emits a LangGraph interrupt payload for external systems to approve/resume. */
function humanApprovalNode(deps: WorkflowDeps, checkpointer: BaseCheckpointSaver) {
  const node: GraphNode<typeof RmsStateAnnotation> = async (state) => {
    const { subject, searchResults, traceId, summarization } = state;
    return withNodeTiming("human_approval", traceId, subject, async () => {
      if (deps.onApprovalRequired) {
        const confidence = summarization?.overallConfidence ?? 0;
        try {
          await deps.onApprovalRequired(subject, confidence);
        } catch {
          /* non-fatal: consumer hook */
        }
      }
      if (checkpointer instanceof MemorySaver) {
        logWarn(
          "HITL interrupt issued with in-memory checkpointer (MemorySaver). " +
            "State will be lost on process restart — HITL resume will fail. " +
            "Set RMS_CHECKPOINTER=sqlite or inject a durable checkpointer.",
          { node: "human_approval", subject, traceId },
        );
      }
      interrupt({
        action: "approve_research",
        subject,
        resultCount: searchResults.length,
        message: "Please approve this research before persistence.",
      });
      return {};
    });
  };
  return node;
}

// ── Conditional Edge Routers ─────────────────────────────────────────

/** Route to guardrail when cache is stale/missing; otherwise skip to persister. */
const routeAfterFreshness: ConditionalEdgeRouter<typeof RmsStateAnnotation> = (state) => {
  if (state.isFresh && !state.forceRefresh && state.cachedResearch) return "persister";
  return "guardrail";
};

/** Route to queryPlanner if guardrail allows; otherwise to persister (blocked). */
const routeAfterGuardrail: ConditionalEdgeRouter<typeof RmsStateAnnotation> = (state) => {
  if (state.error) return "persister";
  return "queryPlanner";
};

/**
 * Route after query relevance evaluation:
 * - If relevant OR max rewrites reached → reranker
 * - If irrelevant and rewrites left → searcher (with rewritten query)
 */
const routeAfterQueryRewriter: ConditionalEdgeRouter<typeof RmsStateAnnotation> = (state) => {
  if (state.rewrittenQuery && state.rewriteCount <= MAX_REWRITES) return "searcher";
  return "reranker";
};

/** Confidence gating: low-confidence summaries (< 0.4) route to human approval for review. */
const routeAfterSummarizer: ConditionalEdgeRouter<typeof RmsStateAnnotation> = (state) => {
  const score = state.summarization?.overallConfidence ?? 1;
  if (score < 0.4) return "human_approval";
  return "persister";
};
