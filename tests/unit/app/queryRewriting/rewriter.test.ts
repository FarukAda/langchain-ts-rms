import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluateQueryRelevance,
  MAX_REWRITES,
  MIN_RELEVANCE_SCORE,
} from "../../../../src/app/queryRewriting/rewriter.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SearxngSearchResult } from "../../../../src/infra/search/searxngClient.js";

const mockSearchResults: SearxngSearchResult[] = [
  {
    title: "React Hooks Guide",
    url: "https://example.com/react",
    snippet: "Learn React hooks.",
    engine: "google",
  },
  {
    title: "Angular Components",
    url: "https://example.com/angular",
    snippet: "Build Angular apps.",
    engine: "bing",
  },
];

function mockChatModel(result: Record<string, unknown>) {
  return {
    withStructuredOutput: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue(result),
    }),
  } as unknown as BaseChatModel;
}

function mockFailingChatModel() {
  return {
    withStructuredOutput: vi.fn().mockReturnValue({
      invoke: vi.fn().mockRejectedValue(new Error("LLM timeout")),
    }),
  } as unknown as BaseChatModel;
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("evaluateQueryRelevance", () => {
  it("returns relevant when score is above threshold", async () => {
    const model = mockChatModel({
      isRelevant: true,
      relevanceScore: 0.8,
      reasoning: "Results are highly relevant to React hooks.",
    });

    const result = await evaluateQueryRelevance("React hooks", mockSearchResults, model);

    expect(result.isRelevant).toBe(true);
    expect(result.relevanceScore).toBe(0.8);
    expect(result.rewrittenQuery).toBeUndefined();
    expect(result.reasoning).toBe("Results are highly relevant to React hooks.");
  });

  it("returns not relevant when score is below threshold", async () => {
    const model = mockChatModel({
      isRelevant: false,
      relevanceScore: 0.2,
      rewrittenQuery: "React hooks tutorial useState useEffect",
      reasoning: "Results are mostly about Angular, not React.",
    });

    const result = await evaluateQueryRelevance("hooks", mockSearchResults, model);

    expect(result.isRelevant).toBe(false);
    expect(result.relevanceScore).toBe(0.2);
    expect(result.rewrittenQuery).toBe("React hooks tutorial useState useEffect");
  });

  it("clamps relevance score to [0, 1]", async () => {
    const model = mockChatModel({
      isRelevant: true,
      relevanceScore: 1.5,
      reasoning: "test",
    });

    const result = await evaluateQueryRelevance("test", mockSearchResults, model);
    expect(result.relevanceScore).toBe(1);
  });

  it("marks as not relevant when LLM says relevant but score is below threshold", async () => {
    const model = mockChatModel({
      isRelevant: true,
      relevanceScore: 0.2, // Below MIN_RELEVANCE_SCORE
      reasoning: "Marginally relevant.",
    });

    const result = await evaluateQueryRelevance("test", mockSearchResults, model);

    // Should be overridden to not relevant due to low score
    expect(result.isRelevant).toBe(false);
  });

  it("gracefully degrades on LLM failure (assumes relevant)", async () => {
    const model = mockFailingChatModel();

    const result = await evaluateQueryRelevance("test", mockSearchResults, model);

    expect(result.isRelevant).toBe(true);
    expect(result.relevanceScore).toBe(0.5);
    expect(result.reasoning).toContain("Evaluation failed");
  });

  it("exports correct constants", () => {
    expect(MAX_REWRITES).toBe(2);
    expect(MIN_RELEVANCE_SCORE).toBe(0.4);
  });
});
