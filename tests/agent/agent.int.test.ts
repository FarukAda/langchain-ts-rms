/**
 * Real LangChain Agent Integration Test
 *
 * Runs a createAgent (LangChain v1) with ChatOllama + all 7 RMS tools
 * against live Qdrant, Ollama, and SearXNG services. Results are enriched
 * with Allure step annotations and prompt/response attachments.
 *
 * Prerequisites:
 *   docker compose up -d qdrant searxng
 *   docker compose --profile ollama up -d ollama
 *   ollama pull nomic-embed-text && ollama pull qwen3:8b
 *
 * Run:
 *   npm run test:agent
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  createAgent,
  createMiddleware,
  toolRetryMiddleware,
  toolCallLimitMiddleware,
  modelRetryMiddleware,
  ToolMessage,
} from "langchain";
import { ChatOllama } from "@langchain/ollama";
import type { AIMessage, BaseMessage } from "@langchain/core/messages";
import * as allure from "allure-js-commons";
import { createAllRmsToolsFromEnv } from "../../src/lib/rmsTool.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { setLogSilent } from "../../src/infra/observability/tracing.js";
import {
  createQdrantClient,
  bootstrapQdrantCollections,
  RESEARCH_COLLECTION,
} from "../../src/infra/vector/qdrantClient.js";

// ── Guard: skip unless infra is available ───────────────────────────
const AGENT_TEST = process.env.RMS_AGENT_TEST === "1";

// ── Types ───────────────────────────────────────────────────────────

interface AgentResult {
  messages: BaseMessage[];
  content: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

async function attachJson(name: string, data: unknown): Promise<void> {
  await allure.attachment(name, JSON.stringify(data, null, 2), "application/json");
}

async function attachText(name: string, text: string): Promise<void> {
  await allure.attachment(name, text, "text/plain");
}

function extractToolCalls(messages: BaseMessage[]): Array<{ tool: string; args: unknown }> {
  const calls: Array<{ tool: string; args: unknown }> = [];
  for (const msg of messages) {
    const ai = msg as AIMessage;
    if (ai.tool_calls && ai.tool_calls.length > 0) {
      for (const tc of ai.tool_calls) {
        calls.push({ tool: tc.name, args: tc.args });
      }
    }
  }
  return calls;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (typeof block?.text === "string") {
        parts.push(block.text);
      } else if (block && typeof block === "object") {
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return typeof content === "undefined" || content === null ? "" : JSON.stringify(content);
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  try {
    let parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed) as unknown;
      } catch {
        // Single-level string
      }
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractAllToolResponses(messages: BaseMessage[]): Record<string, unknown>[] {
  const responses: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.type !== "tool") continue;
    const content = msg.content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
      responses.push(content as Record<string, unknown>);
      continue;
    }
    const text = extractContentText(content);
    if (!text) continue;
    const parsed = tryParseJson(text);
    if (parsed) {
      responses.push(parsed);
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        const blockText =
          typeof block === "string" ? block : typeof block?.text === "string" ? block.text : null;
        if (blockText) {
          const blockParsed = tryParseJson(blockText);
          if (blockParsed) {
            responses.push(blockParsed);
            break;
          }
        }
      }
      continue;
    }
    responses.push({ _raw: text });
  }
  return responses;
}

function findToolResponse(
  messages: BaseMessage[],
  toolName: string,
): Record<string, unknown> | undefined {
  for (let i = 0; i < messages.length; i++) {
    const ai = messages[i] as AIMessage;
    if (ai.tool_calls?.some((tc) => tc.name === toolName)) {
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j]!.type !== "tool") break;
        const text = extractContentText(messages[j]!.content);
        const parsed = tryParseJson(text);
        if (parsed) return parsed;
      }
    }
  }
  return undefined;
}

/**
 * Enhanced tool result finder — distinguishes success, error, and not-called.
 *
 * @returns
 *  - `{ success: true, data: ... }` — tool returned valid JSON
 *  - `{ success: false, error: "..." }` — tool returned an error ToolMessage
 *  - `undefined` — tool was never called
 */
function findToolResult(
  messages: BaseMessage[],
  toolName: string,
):
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string }
  | undefined {
  for (let i = 0; i < messages.length; i++) {
    const ai = messages[i] as AIMessage;
    if (ai.tool_calls?.some((tc) => tc.name === toolName)) {
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j]!.type !== "tool") break;
        const toolMsg = messages[j]!;
        if ((toolMsg as unknown as { status?: string }).status === "error") {
          return { success: false, error: extractContentText(toolMsg.content) };
        }
        const text = extractContentText(toolMsg.content);
        const parsed = tryParseJson(text);
        if (parsed) return { success: true, data: parsed };
      }
    }
  }
  return undefined;
}

function assertToolCalled(
  toolCalls: Array<{ tool: string; args: unknown }>,
  toolName: string,
): { tool: string; args: unknown } {
  const call = toolCalls.find((tc) => tc.tool === toolName);
  expect(
    call,
    `Agent should have called ${toolName} but only called: [${toolCalls.map((c) => c.tool).join(", ")}]`,
  ).toBeDefined();
  return call!;
}

async function invokeAgent(
  agentInstance: ReturnType<typeof createAgent>,
  prompt: string,
): Promise<AgentResult> {
  const raw: AgentResult = (await agentInstance.invoke({
    messages: [{ role: "user", content: prompt }],
  })) as AgentResult;
  const result = raw;
  let content = extractContentText(result.content);
  if (!content && result.messages.length > 0) {
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const msg = result.messages[i];
      if (msg && msg.type === "ai") {
        const extracted = extractContentText(msg.content);
        if (extracted.length > 0) {
          content = extracted;
          break;
        }
      }
    }
  }
  return { messages: result.messages, content };
}

// ── Error-Handling Middleware ────────────────────────────────────────

const rmsToolErrorMiddleware = createMiddleware({
  name: "RmsToolErrorHandler",
  wrapToolCall: async (request, handler) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new ToolMessage({
        content: `Tool '${request.toolCall.name}' error: ${message}`,
        tool_call_id: request.toolCall.id ?? "",
        name: request.toolCall.name,
        status: "error",
      });
    }
  },
});

// ── Test Suite ───────────────────────────────────────────────────────

const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "qwen3:8b";

describe.skipIf(!AGENT_TEST)(`RMS Agent Integration (model: ${CHAT_MODEL})`, () => {
  let agent: ReturnType<typeof createAgent>;
  let allTools: StructuredToolInterface[];

  // State shared across sequential scenarios
  let createdResearchId: string | undefined;
  let lastMessages: BaseMessage[] = [];

  beforeAll(async () => {
    setLogSilent(true);

    // Force deterministic environment for this test file
    process.env.RMS_AGENT_TEST = "1";
    process.env.OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
    process.env.OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "qwen3:8b";
    process.env.QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
    process.env.SEARXNG_API_BASE = process.env.SEARXNG_API_BASE ?? "http://127.0.0.1:8080";

    // CRITICAL: Isolate agent integration tests from parallel workflow integration tests
    // to prevent malicious semantic overwrites during force-refresh scenarios.
    process.env.RMS_TENANT_ID = "agent-integration-test";

    const model = new ChatOllama({
      model: CHAT_MODEL,
      baseUrl: process.env.OLLAMA_HOST,
      temperature: 0,
    });

    // Clean vector database for a fresh test run
    const qdrant = createQdrantClient();
    try {
      await qdrant.deleteCollection(RESEARCH_COLLECTION);
    } catch {
      // Collection may not exist on first run
    }

    // Determine vector size from embedding model
    const { createEmbeddingProvider } =
      await import("../../src/infra/embeddings/embeddingProvider.js");
    const tempEmbed = createEmbeddingProvider();
    const sampleVec = await tempEmbed.embedQuery("test");
    await bootstrapQdrantCollections(qdrant, sampleVec.length);

    const { researchTool, lifecycleTools } = await createAllRmsToolsFromEnv();
    allTools = [researchTool, ...lifecycleTools];

    agent = createAgent({
      model,
      tools: allTools,
      middleware: [
        modelRetryMiddleware({
          maxRetries: 2,
          onFailure: "error",
          initialDelayMs: 2000,
          backoffFactor: 2,
        }),
        toolRetryMiddleware({
          maxRetries: 2,
          retryOn: (err: Error) => {
            const msg = err.message ?? "";
            return (
              msg.includes("ECONNREFUSED") ||
              msg.includes("ETIMEDOUT") ||
              msg.includes("fetch failed") ||
              err.name === "AbortError"
            );
          },
          onFailure: "error",
          initialDelayMs: 500,
          backoffFactor: 2,
        }),
        rmsToolErrorMiddleware,
        // @ts-expect-error -- zod v3/v4 interop: ToolCallLimitConfig resolves to `never` due to InferInteropZodInput structural mismatch
        toolCallLimitMiddleware({ runLimit: 10 }),
      ],
      systemPrompt:
        "You are a Research Management System (RMS) assistant. " +
        "Use the provided RMS tools to help the user research topics and manage research entries. " +
        "IMPORTANT: Call tools ONE AT A TIME — wait for each result before calling the next tool. " +
        "When the user names a specific tool, use that exact tool.",
    });
  }, 300_000);

  /** Dump full message trajectory on failure for diagnostics. */
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === "fail" && lastMessages.length > 0) {
      const trajectory = lastMessages.map((m, i) => ({
        idx: i,
        type: m.type,
        content: extractContentText(m.content).slice(0, 2000),
        ...(m.type === "ai" ? { tool_calls: (m as AIMessage).tool_calls } : {}),
      }));
      await allure.step("DIAGNOSTIC: Full message trajectory on failure", async () => {
        await attachJson("failure_trajectory", trajectory);
      });
      console.error(
        `\n[DIAGNOSTIC] Test "${ctx.task.name}" failed. Message trajectory:\n` +
          JSON.stringify(trajectory, null, 2),
      );
    }
  });

  // ── Scenario 1: Research a topic ──────────────────────────────────

  it("researches a topic and stores the result", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_research");
    await allure.severity("critical");

    const userPrompt =
      "Research the topic 'TypeScript best practices for Node.js'. Use the rms_research tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
      await attachJson(
        "full_trajectory",
        messages.map((m) => ({
          type: m.type,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })),
      );
    });

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    assertToolCalled(toolCalls, "rms_research");

    const researchResponse = findToolResponse(messages, "rms_research");
    expect(researchResponse, "rms_research response must be parseable").toBeDefined();
    expect(researchResponse!.version, "Response should include contract version").toBe("1.0");

    // Extract research ID for subsequent tests
    const research = researchResponse!.research as Record<string, unknown> | undefined;
    expect(research, "Response should contain research object").toBeDefined();
    if (research?.id) {
      createdResearchId = research.id as string;
    }

    await allure.step("Extracted research ID", async () => {
      await attachText("research_id", createdResearchId ?? "NOT_FOUND");
    });

    expect(createdResearchId).toBeDefined();
    expect(research!.subject).toBeDefined();
    expect(research!.summary).toBeDefined();
  }, 600_000);

  // ── Scenario 2: Get research details ──────────────────────────────

  it("retrieves the created research by ID", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_get_research");

    expect(createdResearchId).toBeDefined();

    const userPrompt = `Get the details of research ${createdResearchId}. Use the rms_get_research tool.`;

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_get_research");
    expect(content.length).toBeGreaterThan(0);

    const getResponse = findToolResponse(messages, "rms_get_research");
    expect(getResponse, "rms_get_research response must be parseable").toBeDefined();
    expect(getResponse!.version).toBe("1.0");
    const research = getResponse!.research as Record<string, unknown> | undefined;
    expect(research, "Response should contain research object").toBeDefined();
    expect(research!.id, "Research ID should match").toBe(createdResearchId);
    expect(
      typeof research!.subject === "string" && research!.subject.length > 0,
      "subject should be a non-empty string",
    ).toBe(true);
    expect(
      typeof research!.summary === "string" && research!.summary.length > 0,
      "summary should be a non-empty string",
    ).toBe(true);
  }, 300_000);

  // ── Scenario 3: List all research ─────────────────────────────────

  it("lists all research entries", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_list_research");

    const userPrompt = "List all my research entries. Use the rms_list_research tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_list_research");

    // Version contract assertion
    const listToolResponse = findToolResponse(messages, "rms_list_research");
    expect(listToolResponse, "rms_list_research response must be parseable").toBeDefined();
    expect(listToolResponse!.version).toBe("1.0");

    expect(toolResponses.length).toBeGreaterThanOrEqual(1);
    const listResponse = toolResponses.find(
      (r) => Array.isArray(r.items) || typeof r.total === "number",
    );
    expect(listResponse, "Tool response should contain items or total field").toBeDefined();
    expect(Array.isArray(listResponse!.items)).toBe(true);
    expect(typeof listResponse!.total === "number", "total should be a number").toBe(true);
    const items = listResponse!.items as Array<Record<string, unknown>>;
    expect(items.length, "Should list at least the research we created").toBeGreaterThanOrEqual(1);

    // Cross-scenario: verify our research appears in the list
    const ourResearch = items.find((r) => r.id === createdResearchId);
    expect(ourResearch, "Created research should appear in list").toBeDefined();
  }, 300_000);

  // ── Scenario 4: Search research ───────────────────────────────────

  it("searches for research by query", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_search_research");

    const userPrompt = "Search for research about TypeScript. Use the rms_search_research tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_search_research");

    // Version contract assertion
    const searchToolResponse = findToolResponse(messages, "rms_search_research");
    expect(searchToolResponse, "rms_search_research response must be parseable").toBeDefined();
    expect(searchToolResponse!.version).toBe("1.0");

    expect(toolResponses.length).toBeGreaterThanOrEqual(1);
    const searchResponse = toolResponses.find(
      (r) => Array.isArray(r.results) || typeof r.total === "number",
    );
    expect(searchResponse, "Search response should contain results").toBeDefined();
    expect(Array.isArray(searchResponse!.results), "results should be an array").toBe(true);
    expect(
      (searchResponse!.results as unknown[]).length,
      "Should find at least one search result",
    ).toBeGreaterThanOrEqual(1);
  }, 300_000);

  // ── Scenario 5: Get current date/time ─────────────────────────────

  it("gets the current date and time", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_get_datetime");

    const userPrompt = "What is the current date and time? Use the rms_get_datetime tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_get_datetime");

    const dateResponse = findToolResponse(messages, "rms_get_datetime");
    expect(dateResponse, "rms_get_datetime response must be parseable").toBeDefined();
    expect(dateResponse!.version).toBe("1.0");
    expect(dateResponse!.iso).toBeDefined();
    expect(dateResponse!.timezone).toBeDefined();
    expect(typeof dateResponse!.unix === "number", "unix should be a number").toBe(true);
    expect(dateResponse!.date, "date should be defined").toBeDefined();
    expect(dateResponse!.dayOfWeek, "dayOfWeek should be defined").toBeDefined();
  }, 300_000);

  // ── Scenario 6: Refresh research ──────────────────────────────────

  it("force-refreshes the research entry", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_refresh_research");

    expect(createdResearchId).toBeDefined();

    const userPrompt = `Refresh research ${createdResearchId}. Use the rms_refresh_research tool.`;

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_refresh_research");

    const refreshResponse = findToolResponse(messages, "rms_refresh_research");
    expect(refreshResponse, "rms_refresh_research response must be parseable").toBeDefined();
    expect(refreshResponse!.version).toBe("1.0");
    expect(refreshResponse!.wasRefreshed).toBe(true);

    // Validate refreshed research content
    const research = refreshResponse!.research as Record<string, unknown> | undefined;
    expect(research, "Response should contain refreshed research object").toBeDefined();
    expect(
      typeof research!.subject === "string" && research!.subject.length > 0,
      "Refreshed subject should be non-empty",
    ).toBe(true);
    expect(
      typeof research!.summary === "string" && research!.summary.length > 0,
      "Refreshed summary should be non-empty",
    ).toBe(true);

    // Update the research ID since refresh creates a new entry
    if (research?.id) {
      createdResearchId = research.id as string;
    }
  }, 600_000);

  // ── Scenario 7: List after refresh (cross-scenario validation) ────

  it("lists research and verifies the refreshed entry appears", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_list_research (post-refresh)");

    expect(createdResearchId).toBeDefined();

    const userPrompt = "List all my research entries. Use the rms_list_research tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_list_research");

    const listResponse = toolResponses.find(
      (r) => Array.isArray(r.items) || typeof r.total === "number",
    );
    expect(listResponse, "Tool response should contain items or total field").toBeDefined();
    expect(Array.isArray(listResponse!.items)).toBe(true);
    const items = listResponse!.items as Array<Record<string, unknown>>;
    expect(items.length, "Should list at least the refreshed research").toBeGreaterThanOrEqual(1);

    // Cross-scenario: verify our refreshed research appears
    const ourResearch = items.find((r) => r.id === createdResearchId);
    expect(ourResearch, "Refreshed research should appear in list").toBeDefined();
  }, 300_000);

  // ── Scenario 8: Semantic search finds created research ────────────

  it("semantic search finds the research created in scenario 1", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_search_research (cross-scenario)");

    expect(createdResearchId).toBeDefined();

    const userPrompt =
      "Search for research about TypeScript Node.js. Use the rms_search_research tool.";

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_search_research");

    // Validate the search returned results from semantic search
    expect(toolResponses.length, "Expected at least one tool response").toBeGreaterThanOrEqual(1);
    const searchResponse = toolResponses.find(
      (r) => Array.isArray(r.results) || typeof r.total === "number",
    );
    expect(searchResponse, "Semantic search response should contain results").toBeDefined();
    expect(
      Array.isArray(searchResponse!.results),
      "Search response should contain results array",
    ).toBe(true);
    expect(
      (searchResponse!.results as unknown[]).length,
      "Semantic search should find the research created in scenario 1",
    ).toBeGreaterThanOrEqual(1);
  }, 300_000);

  // ── Scenario 9: Delete research ───────────────────────────────────

  it("deletes the research entry", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_delete_research");

    expect(createdResearchId).toBeDefined();

    const userPrompt = `Delete research ${createdResearchId}. Use the rms_delete_research tool.`;

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_delete_research");

    const deleteResponse = findToolResponse(messages, "rms_delete_research");
    expect(deleteResponse, "rms_delete_research response must be parseable").toBeDefined();
    expect(deleteResponse!.version).toBe("1.0");
    expect(deleteResponse!.deleted).toBe(true);
    expect(deleteResponse!.researchId).toBe(createdResearchId);
  }, 300_000);

  // ── Scenario 10: Verify delete ────────────────────────────────────

  it("confirms deleted research returns not found", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_get_research (post-delete)");

    expect(createdResearchId).toBeDefined();

    const userPrompt = `Get the details of research ${createdResearchId}. Use the rms_get_research tool.`;

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_get_research");

    // Use findToolResult for proper error/success discrimination
    const getResult = findToolResult(messages, "rms_get_research");
    expect(getResult, "rms_get_research should have been called").toBeDefined();
    // Accept either: error field in success data, or error ToolMessage
    if (getResult!.success) {
      expect(
        getResult!.data.error,
        "Success response should contain error field for deleted research",
      ).toBeDefined();
    } else {
      expect(getResult!.error.length, "Error message should be non-empty").toBeGreaterThan(0);
    }
  }, 300_000);

  // ── Scenario 11: Invalid ID error handling ────────────────────────

  it("returns error for a completely bogus research ID", async () => {
    await allure.epic("RMS Agent Integration");
    await allure.feature("Tool: rms_get_research (invalid ID)");

    const bogusId = "00000000-0000-0000-0000-000000000000";
    const userPrompt = `Get the details of research ${bogusId}. Use the rms_get_research tool.`;

    await allure.step("Send prompt to agent", async () => {
      await attachText("user_prompt", userPrompt);
    });

    const { messages, content } = await invokeAgent(agent, userPrompt);
    lastMessages = messages;
    const toolCalls = extractToolCalls(messages);
    const toolResponses = extractAllToolResponses(messages);

    await allure.step("Agent response", async () => {
      await attachText("final_response", content);
      await attachJson("tool_calls", toolCalls);
      await attachJson("tool_responses", toolResponses);
    });

    assertToolCalled(toolCalls, "rms_get_research");

    // Should return an error, either as a structured error or error ToolMessage
    const getResult = findToolResult(messages, "rms_get_research");
    expect(getResult, "rms_get_research should have been called").toBeDefined();
    if (getResult!.success) {
      expect(
        getResult!.data.error,
        "Success response should contain error field for bogus ID",
      ).toBeDefined();
    } else {
      expect(getResult!.error.length, "Error message should be non-empty").toBeGreaterThan(0);
    }
  }, 300_000);
});
