import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { IResearchRepository } from "../domain/ports.js";
import { ResearchStatusSchema } from "../domain/contracts.js";
import { ResearchRepository } from "../infra/vector/researchRepository.js";
import { createEmbeddingProvider } from "../infra/embeddings/embeddingProvider.js";
import { createChatModelProvider } from "../infra/chat/chatModelProvider.js";
import { bootstrapQdrantCollections, createQdrantClient } from "../infra/vector/qdrantClient.js";
import { RESPONSE_CONTRACT_VERSION } from "../domain/contracts.js";
import { checkHealth } from "../infra/healthCheck.js";
import { conductResearchDirect } from "../lib/tools/research.js";
import type { RmsToolDeps } from "../lib/types.js";
import { getResearchOrThrow } from "../lib/helpers.js";
import { createCheckpointer } from "../infra/checkpoint/checkpointerFactory.js";
import { loadEnv } from "../config/env.js";
import { logInfo, logWarn } from "../infra/observability/tracing.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing the MCP server. */
export interface RmsMcpServerOptions {
  /** Pre-built repository (skips env-driven construction). */
  researchRepository?: IResearchRepository;
  /** Pre-built embedding model. */
  embeddings?: EmbeddingsInterface;
  /** Pre-built chat model. */
  chatModel?: BaseChatModel;
  /** Whether to bootstrap Qdrant collections on startup. Default: true. */
  bootstrap?: boolean;
  /** Research freshness in days. Default: 7. */
  freshnessDays?: number;
  /**
   * Bearer token for MCP request authentication.
   * When set, every tool call must include this token.
   * Read from `RMS_MCP_AUTH_TOKEN` env var if not provided.
   */
  authToken?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap data as MCP text/plain content. */
function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** MCP tool handler return type for auth failures. */
type McpTextResult = { content: Array<{ type: "text"; text: string }> };

/**
 * Validates an auth token from the raw MCP tool input against the expected value.
 * Extracts `authToken` from the input object internally so callers don't need to
 * fight the narrowly-typed schema output.
 *
 * When `expected` is undefined/empty, auth is disabled and all calls pass.
 */
function validateAuth(
  input: Record<string, unknown>,
  expected: string | undefined,
): { valid: true } | { valid: false; response: McpTextResult } {
  if (!expected) return { valid: true };
  const provided = input["authToken"] as string | undefined;
  if (!provided || provided !== expected) {
    logWarn("MCP auth failed: invalid or missing token");
    return {
      valid: false,
      response: textResult({
        error: "Authentication failed: invalid or missing auth token",
        errorCode: "RMS_AUTH_FAILED",
      }),
    };
  }
  return { valid: true };
}

/**
 * Returns the auth token Zod schema fragment.
 * When auth is enabled, the field is required. When disabled, it's omitted
 * (empty object) so it does not pollute the tool schema for unauthenticated servers.
 */
function authTokenSchema(authToken: string | undefined): Record<string, z.ZodType> {
  if (!authToken) return {};
  return {
    authToken: z
      .string()
      .describe("Authentication token. Required when the server has auth enabled."),
  };
}

/** Build deps from env or provided options. */
async function buildDeps(opts: RmsMcpServerOptions = {}): Promise<{
  repo: IResearchRepository;
  embeddings: EmbeddingsInterface;
  chatModel: BaseChatModel;
  checkpointer: BaseCheckpointSaver;
}> {
  const embeddings = opts.embeddings ?? createEmbeddingProvider();
  const chatModel = opts.chatModel ?? createChatModelProvider();
  const client = createQdrantClient();
  const repo = opts.researchRepository ?? new ResearchRepository({ embeddings, client });
  const checkpointer = await createCheckpointer();

  if (opts.bootstrap !== false) {
    const vectorSize = (await embeddings.embedQuery("test")).length;
    await bootstrapQdrantCollections(client, vectorSize);
  }

  return { repo, embeddings, chatModel, checkpointer };
}

/** Build RmsToolDeps from resolved deps. */
function toToolDeps(
  repo: IResearchRepository,
  embeddings: EmbeddingsInterface,
  chatModel: BaseChatModel,
  freshnessDays?: number,
  checkpointer?: BaseCheckpointSaver,
): Omit<RmsToolDeps, "toolName" | "toolDescription"> {
  return {
    researchRepository: repo,
    embeddings,
    chatModel,
    ...(freshnessDays != null && { freshnessDays }),
    ...(checkpointer != null && { checkpointer }),
  };
}

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

/**
 * Creates a configured MCP server with all RMS tools registered.
 *
 * @example
 * ```ts
 * const server = await createRmsMcpServer();
 * const transport = new StdioServerTransport();
 * await server.connect(transport);
 * ```
 */
export async function createRmsMcpServer(opts: RmsMcpServerOptions = {}): Promise<McpServer> {
  const { repo, embeddings, chatModel, checkpointer } = await buildDeps(opts);
  const toolDeps = toToolDeps(repo, embeddings, chatModel, opts.freshnessDays, checkpointer);
  const expectedToken = opts.authToken;
  const authSchema = authTokenSchema(expectedToken);

  const server = new McpServer({
    name: "@farukada/langchain-ts-rms",
    version: "0.1.0",
  });

  // ── rms_research ──────────────────────────────────────────────────────
  server.tool(
    "rms_research",
    "Research a topic thoroughly. Checks the RAG cache for fresh results, " +
      "generates search queries, runs web searches, reranks, summarizes, and " +
      "stores the result. Returns a full research report.",
    {
      ...authSchema,
      subject: z.string().describe("The topic or question to research"),
      forceRefresh: z
        .boolean()
        .optional()
        .describe("Force new research even if cached data exists"),
      maxResults: z
        .number()
        .int()
        .optional()
        .describe("Maximum search results per query (default: 10)"),
      tenantId: z.string().optional().describe("Tenant identifier for multi-tenancy"),
      traceId: z.string().optional().describe("Trace ID for observability correlation"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        const result = await conductResearchDirect(input, toolDeps);
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          ...result,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_RESEARCH_FAILED",
        });
      }
    },
  );

  // ── rms_get_research ──────────────────────────────────────────────────
  server.tool(
    "rms_get_research",
    "Retrieve a specific research entry by its UUID.",
    {
      ...authSchema,
      researchId: z.uuid().describe("UUID of the research entry to retrieve"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        const research = await getResearchOrThrow(repo, input.researchId);
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          research,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_GET_RESEARCH_FAILED",
        });
      }
    },
  );

  // ── rms_list_research ─────────────────────────────────────────────────
  server.tool(
    "rms_list_research",
    "List all research entries with optional status/tenant filtering and pagination.",
    {
      ...authSchema,
      status: z
        .array(z.enum(ResearchStatusSchema.options))
        .optional()
        .describe("Filter by research statuses"),
      tenantId: z.string().optional().describe("Filter by tenant identifier"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum entries to return (default: 20, max: 200)"),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Number of entries to skip for pagination"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        const result = await repo.list({
          status: input.status,
          tenantId: input.tenantId,
          limit: input.limit,
          offset: input.offset,
        });
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          ...result,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_LIST_RESEARCH_FAILED",
        });
      }
    },
  );

  // ── rms_search_research ───────────────────────────────────────────────
  server.tool(
    "rms_search_research",
    "Semantically search stored research entries by query similarity.",
    {
      ...authSchema,
      query: z.string().describe("Search query for semantic similarity matching"),
      tenantId: z.string().optional().describe("Filter by tenant identifier"),
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum results to return (default: 5)"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        const searchOpts: { k?: number; filter?: { tenantId?: string; tags?: string[] } } = {};
        if (input.limit != null) searchOpts.k = input.limit;
        const filterObj: { tenantId?: string; tags?: string[] } = {};
        if (input.tenantId != null) filterObj.tenantId = input.tenantId;
        if (input.tags != null) filterObj.tags = input.tags;
        if (Object.keys(filterObj).length > 0) searchOpts.filter = filterObj;
        const results = await repo.search(input.query, searchOpts);
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          results: results.map((r) => ({
            research: r.research,
            score: r.score,
          })),
          total: results.length,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_SEARCH_FAILED",
        });
      }
    },
  );

  // ── rms_delete_research ───────────────────────────────────────────────
  server.tool(
    "rms_delete_research",
    "Delete a research entry by its UUID.",
    {
      ...authSchema,
      researchId: z.uuid().describe("UUID of the research entry to delete"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        // Verify it exists first
        await getResearchOrThrow(repo, input.researchId);
        await repo.deleteByIds([input.researchId]);
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          deleted: true,
          researchId: input.researchId,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_DELETE_FAILED",
        });
      }
    },
  );

  // ── rms_refresh_research ──────────────────────────────────────────────
  server.tool(
    "rms_refresh_research",
    "Force-refresh an existing research entry with new web data.",
    {
      ...authSchema,
      researchId: z.uuid().describe("UUID of the research entry to refresh"),
      maxResults: z
        .number()
        .int()
        .optional()
        .describe("Maximum search results per query (default: 10)"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        const existing = await getResearchOrThrow(repo, input.researchId);
        const result = await conductResearchDirect(
          {
            subject: existing.subject,
            forceRefresh: true,
            maxResults: input.maxResults,
            tenantId: existing.tenantId,
          },
          toolDeps,
        );
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          refreshed: true,
          ...result,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_REFRESH_FAILED",
        });
      }
    },
  );

  // ── rms_get_datetime ──────────────────────────────────────────────────
  server.tool(
    "rms_get_datetime",
    "Get the current date, time, and timezone.",
    {
      ...authSchema,
    },
    (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      const now = new Date();
      return textResult({
        version: RESPONSE_CONTRACT_VERSION,
        date: now.toLocaleDateString(),
        time: now.toLocaleTimeString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        iso: now.toISOString(),
      });
    },
  );

  // ── rms_get_progress ──────────────────────────────────────────────────
  server.tool(
    "rms_get_progress",
    "Get aggregate statistics on stored research entries.",
    {
      ...authSchema,
      tenantId: z.string().optional().describe("Filter stats by tenant identifier"),
    },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;
      try {
        // Paginate through all entries to compute accurate stats
        const PAGE_SIZE = 200;
        const byStatus: Record<string, number> = {};
        let totalConfidence = 0;
        let totalItems = 0;
        let offset = 0;
        let serverTotal = 0;

        while (true) {
          const page = await repo.list({
            tenantId: input.tenantId,
            limit: PAGE_SIZE,
            offset,
          });
          serverTotal = page.total;

          for (const item of page.items) {
            byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
            totalConfidence += item.confidenceScore;
            totalItems++;
          }

          if (page.items.length < PAGE_SIZE || totalItems >= serverTotal) break;
          offset += PAGE_SIZE;
        }

        const stale = await repo.findStale(new Date(), {
          tenantId: input.tenantId,
        });

        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          total: serverTotal,
          byStatus,
          averageConfidence: totalItems > 0 ? +(totalConfidence / totalItems).toFixed(2) : 0,
          staleCount: stale.length,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_PROGRESS_FAILED",
        });
      }
    },
  );

  // ── Health Check ──────────────────────────────────────────────────

  server.tool(
    "rms_health_check",
    "Check the health and latency of all RMS backend services (Qdrant, Ollama, SearxNG). " +
      "Returns per-service status with latency in milliseconds.",
    { ...authSchema },
    async (input) => {
      const auth = validateAuth(input as Record<string, unknown>, expectedToken);
      if (!auth.valid) return auth.response;

      try {
        const health = await checkHealth();
        return textResult({
          version: RESPONSE_CONTRACT_VERSION,
          allOk: health.qdrant.ok && health.ollama.ok && health.searxng.ok,
          qdrant: health.qdrant,
          ollama: health.ollama,
          searxng: health.searxng,
        });
      } catch (err) {
        return textResult({
          error: err instanceof Error ? err.message : String(err),
          errorCode: "RMS_HEALTH_CHECK_FAILED",
        });
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

/**
 * Convenience entry-point: creates + connects an MCP server over stdio.
 *
 * @example
 * ```ts
 * import { startMcpServer } from "@farukada/langchain-ts-rms/mcp";
 * await startMcpServer();
 * ```
 */
export async function startMcpServer(opts: RmsMcpServerOptions = {}): Promise<void> {
  // If no auth token provided, fall back to env var
  if (opts.authToken == null) {
    try {
      const env = loadEnv();
      if (env.RMS_MCP_AUTH_TOKEN) {
        opts = { ...opts, authToken: env.RMS_MCP_AUTH_TOKEN };
      }
    } catch {
      // loadEnv may fail if required vars are missing — non-fatal for auth
    }
  }

  const server = await createRmsMcpServer(opts);
  const transport = new StdioServerTransport();

  // Graceful shutdown on process signals
  const shutdown = () => {
    logInfo("MCP server shutting down");
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logInfo("RMS MCP server starting", { auth: opts.authToken ? "enabled" : "disabled" });
  await server.connect(transport);
}
