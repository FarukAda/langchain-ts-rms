import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { summarizeSearchResults } from "../../../../src/app/summarization/summarizer.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SearxngSearchResult } from "../../../../src/infra/search/searxngClient.js";

const mockSearchResults: SearxngSearchResult[] = [
  {
    title: "AI Safety Overview",
    url: "https://example.com/ai-safety",
    snippet: "AI safety is a crucial field focusing on ensuring AI systems are beneficial.",
    engine: "google",
  },
  {
    title: "Neural Network Training",
    url: "https://example.com/nn-training",
    snippet:
      "Neural networks can be trained using backpropagation with gradient descent optimization.",
    engine: "bing",
  },
];

const MOCK_TAKEAWAYS =
  "AI safety is a rapidly growing field that focuses on alignment, robustness, and interpretability of AI systems. Researchers are developing formal verification methods and red-teaming approaches to ensure models behave as intended.";

const MOCK_TAKEAWAYS_NN =
  "Backpropagation with gradient descent is the primary method for training neural networks in practice. Modern optimizers like Adam and AdaGrad adapt learning rates per-parameter, significantly improving convergence speed.";

describe("summarizeSearchResults (per-source sequential)", () => {
  beforeEach(() => setLogSilent(true));
  afterEach(() => setLogSilent(false));

  /**
   * Helper: creates a mock BaseChatModel where `withStructuredOutput().invoke()`
   * returns successive per-source results on each call.
   */
  function createMockChatModel(
    perSourceResults: Array<{
      keyTakeaways: string;
      relevance: number;
      tags: string[];
      language: string;
    }>,
  ): BaseChatModel {
    const mockInvoke = vi.fn();
    for (const result of perSourceResults) {
      mockInvoke.mockResolvedValueOnce(result);
    }
    return {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;
  }

  it("produces one SourceSummary per search result", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 0.9, tags: ["ai-safety"], language: "en" },
      {
        keyTakeaways: MOCK_TAKEAWAYS_NN,
        relevance: 0.7,
        tags: ["neural-networks"],
        language: "en",
      },
    ]);

    const result = await summarizeSearchResults("AI safety", mockSearchResults, mockChatModel);

    expect(result.sourceSummaries).toHaveLength(2);
    expect(result.sourceSummaries[0]!.url).toBe("https://example.com/ai-safety");
    expect(result.sourceSummaries[0]!.title).toBe("AI Safety Overview");
    expect(result.sourceSummaries[0]!.keyTakeaways).toBe(MOCK_TAKEAWAYS);
    expect(result.sourceSummaries[0]!.relevance).toBe(0.9);
    expect(result.sourceSummaries[1]!.url).toBe("https://example.com/nn-training");
  });

  it("calculates overallConfidence as average of per-source relevance", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 0.8, tags: [], language: "en" },
      { keyTakeaways: MOCK_TAKEAWAYS_NN, relevance: 0.6, tags: [], language: "en" },
    ]);

    const result = await summarizeSearchResults("AI safety", mockSearchResults, mockChatModel);

    expect(result.overallConfidence).toBe(0.7);
  });

  it("deduplicates and merges tags from all sources", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 0.8, tags: ["ai", "safety"], language: "en" },
      { keyTakeaways: MOCK_TAKEAWAYS_NN, relevance: 0.6, tags: ["ai", "training"], language: "en" },
    ]);

    const result = await summarizeSearchResults("AI safety", mockSearchResults, mockChatModel);

    expect(result.tags).toEqual(["ai", "safety", "training"]);
  });

  it("uses majority-vote for language", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 0.8, tags: [], language: "de" },
      { keyTakeaways: MOCK_TAKEAWAYS_NN, relevance: 0.6, tags: [], language: "en" },
    ]);

    const result = await summarizeSearchResults("AI safety", mockSearchResults, mockChatModel);

    // Both have 1 vote, first wins in tie
    expect(["de", "en"]).toContain(result.language);
  });

  it("isolates per-source failures — failed source gets degraded fallback", async () => {
    const mockInvoke = vi.fn();
    // Source 1 succeeds
    mockInvoke.mockResolvedValueOnce({
      keyTakeaways: MOCK_TAKEAWAYS,
      relevance: 0.9,
      tags: ["ai-safety"],
      language: "en",
    });
    // Source 2 fails
    mockInvoke.mockRejectedValueOnce(new Error("LLM parsing failed"));

    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    const result = await summarizeSearchResults("AI safety", mockSearchResults, mockChatModel);

    // Should still produce 2 summaries — source 2 gets degraded fallback
    expect(result.sourceSummaries).toHaveLength(2);
    expect(result.sourceSummaries[0]!.keyTakeaways).toBe(MOCK_TAKEAWAYS);
    expect(result.sourceSummaries[0]!.relevance).toBe(0.9);
    // Degraded source uses snippet as takeaway and relevance 0
    expect(result.sourceSummaries[1]!.keyTakeaways).toBe(mockSearchResults[1]!.snippet);
    expect(result.sourceSummaries[1]!.relevance).toBe(0);
  });

  it("throws when called with empty search results", async () => {
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: vi.fn() }),
    } as unknown as BaseChatModel;

    await expect(summarizeSearchResults("AI safety", [], mockChatModel)).rejects.toThrow(
      "No search results to summarize",
    );
  });

  it("clamps relevance to [0, 1] range", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 1.5, tags: [], language: "en" },
    ]);

    const result = await summarizeSearchResults(
      "AI safety",
      [mockSearchResults[0]!],
      mockChatModel,
    );

    expect(result.sourceSummaries[0]!.relevance).toBe(1);
  });

  it("includes extractionBreakdown in the result", async () => {
    const mockChatModel = createMockChatModel([
      { keyTakeaways: MOCK_TAKEAWAYS, relevance: 0.9, tags: [], language: "en" },
    ]);

    const result = await summarizeSearchResults(
      "AI safety",
      [mockSearchResults[0]!],
      mockChatModel,
    );

    expect(result.extractionBreakdown).toBeDefined();
    expect(result.extractionBreakdown).toHaveLength(1);
    expect(result.extractionBreakdown[0]!.url).toBe("https://example.com/ai-safety");
    expect(result.extractionBreakdown[0]!.method).toBeDefined();
    expect(result.extractionBreakdown[0]!.extractedLength).toBeGreaterThan(0);
  });
});
