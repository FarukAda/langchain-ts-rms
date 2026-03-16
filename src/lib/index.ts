// ── Public API entrypoint for @farukada/langchain-ts-rms ──

// Tool composite factories
export {
  createRmsLifecycleTools,
  createRmsToolFromEnv,
  createRmsLifecycleToolsFromEnv,
  createAllRmsToolsFromEnv,
} from "./rmsTool.js";

// Individual tool factories
export {
  createResearchTool,
  buildWorkflowDeps,
  conductResearchDirect,
  streamResearch,
} from "./tools/research.js";
export { createGetResearchTool } from "./tools/getResearch.js";
export { createListResearchTool } from "./tools/listResearch.js";
export { createSearchResearchTool } from "./tools/searchResearch.js";
export { createDeleteResearchTool } from "./tools/deleteResearch.js";
export { createGetDatetimeTool } from "./tools/getDatetime.js";
export { createRefreshResearchTool } from "./tools/refreshResearch.js";

// Types
export type { RmsToolDeps, CreateRmsToolFromEnvOptions, AllRmsTools } from "./types.js";

// Helpers
export {
  stripNulls,
  normalizeInput,
  paginate,
  wrapToolResponse,
  getResearchOrThrow,
  matchesFilters,
} from "./helpers.js";

// Schemas
export { RmsResearchInputSchema, laxBool, laxInt, laxFloat } from "./schemas/researchSchemas.js";
export type { RmsResearchInput } from "./schemas/researchSchemas.js";
export {
  GetResearchInputSchema,
  ListResearchInputSchema,
  SearchResearchInputSchema,
  DeleteResearchInputSchema,
  GetDateTimeInputSchema,
  RefreshResearchInputSchema,
  coerceLifecycleInput,
} from "./schemas/lifecycleSchemas.js";

// Streaming Events
export type { RmsEventType, RmsEvent } from "./tools/research.js";
export { RMS_NODE_NAMES } from "../app/graph/workflow.js";
export { summarizeTokenUsage } from "./helpers.js";

// Domain contracts
export {
  ResearchSchema,
  ResearchStatusSchema,
  SourceSummarySchema,
  RESPONSE_CONTRACT_VERSION,
} from "../domain/contracts.js";
export type { Research, ResearchStatus, SourceSummaryEntry } from "../domain/contracts.js";
export {
  isResearchFresh,
  calculateExpiresAt,
  buildResearch,
  buildCompositeSummary,
  mergeResearchMetadata,
  getResearchAge,
  getResearchAgeDays,
} from "../domain/researchUtils.js";

// Core logic
export { evaluateFreshness } from "../app/freshness/evaluator.js";
export type { FreshnessResult } from "../app/freshness/evaluator.js";
export { summarizeSearchResults, normalizeTags } from "../app/summarization/summarizer.js";
export type { SummarizationResult, SourceSummary } from "../app/summarization/summarizer.js";
export {
  SourceSummaryOutputSchema,
  BatchSummaryOutputSchema,
} from "../app/summarization/summarizationSchema.js";
export type {
  SourceSummaryOutput,
  BatchSummaryOutput,
} from "../app/summarization/summarizationSchema.js";
export { synthesizeSummary } from "../app/summarization/synthesizer.js";
export type { SynthesisResult } from "../app/summarization/synthesizer.js";
export { SynthesisOutputSchema } from "../app/summarization/synthesisSchema.js";
export type { SynthesisOutput } from "../app/summarization/synthesisSchema.js";

// Query rewriting (agentic RAG)
export {
  evaluateQueryRelevance,
  MAX_REWRITES,
  MIN_RELEVANCE_SCORE,
} from "../app/queryRewriting/rewriter.js";
export type { QueryRewriteResult, QueryRewriteOutput } from "../app/queryRewriting/rewriter.js";

// Re-ranking
export { rerankSearchResults } from "../app/reranking/reranker.js";
export type { RerankOptions, RankedResult } from "../app/reranking/reranker.js";

// Query planning
export { planSearchQueries } from "../app/queryPlanning/planner.js";
export { QueryPlanOutputSchema } from "../app/queryPlanning/planner.js";
export type { QueryPlanOutput } from "../app/queryPlanning/planner.js";

// LangGraph workflow
export { createRmsWorkflow } from "../app/graph/workflow.js";
export type { WorkflowDeps } from "../app/graph/workflow.js";
export { RmsStateAnnotation } from "../app/state/schema.js";
export type { RmsState, RmsPhase } from "../app/state/schema.js";

// Governance
export {
  checkGuardrail,
  requiresHumanApproval,
  evaluateGuardrails,
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_MIN_CONFIDENCE,
} from "../app/governance/guardrails.js";
export type {
  GuardrailOptions,
  HumanApprovalOptions,
  GuardrailCheck,
  GuardrailResult,
} from "../app/governance/guardrails.js";

// Infrastructure factories
export { createEmbeddingProvider } from "../infra/embeddings/embeddingProvider.js";
export { createChatModelProvider } from "../infra/chat/chatModelProvider.js";
export { performSearch } from "../infra/search/searxngClient.js";
export type { SearxngSearchResult } from "../infra/search/searxngClient.js";
export {
  isBlockedUrl,
  filterBlockedUrls,
  DEFAULT_BLOCKED_DOMAINS,
} from "../infra/search/urlBlocklist.js";
export {
  extractContent,
  extractTextFromHtml,
  batchExtractContent,
} from "../infra/content/contentExtractor.js";
export type {
  ExtractedContent,
  ContentExtractionOptions,
} from "../infra/content/contentExtractor.js";
export {
  createQdrantClient,
  bootstrapQdrantCollections,
  RESEARCH_COLLECTION,
} from "../infra/vector/qdrantClient.js";
export { ResearchRepository } from "../infra/vector/researchRepository.js";
export type { IResearchRepository } from "../domain/ports.js";
export type {
  ResearchSearchFilter,
  ResearchListOptions,
  ResearchListResult,
} from "../domain/ports.js";

// Observability
export {
  log,
  logInfo,
  logWarn,
  logError,
  logDebug,
  setLogWriter,
  setLogSilent,
  setLogLevel,
  withNodeTiming,
  ErrorCodes,
} from "../infra/observability/tracing.js";

// Config
export { loadEnv, resetEnv } from "../config/env.js";
export type { Env } from "../config/env.js";

// Checkpointer
export { createCheckpointer } from "../infra/checkpoint/checkpointerFactory.js";
export type { CheckpointerOptions } from "../infra/checkpoint/checkpointerFactory.js";

// Health Check
export { checkHealth } from "../infra/healthCheck.js";
export type { HealthStatus, ServiceHealth } from "../infra/healthCheck.js";

// Rate Limiting
export {
  TokenBucketLimiter,
  searchLimiter,
  contentLimiter,
  createSearchLimiter,
  createContentLimiter,
} from "../infra/rateLimit/rateLimiter.js";
export {
  CircuitBreaker,
  searchBreaker,
  contentBreaker,
} from "../infra/rateLimit/circuitBreaker.js";
export type { CircuitBreakerOptions } from "../infra/rateLimit/circuitBreaker.js";

// Token Usage
export { TokenUsageCollector } from "../infra/observability/tokenCounter.js";
