import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { synthesizeSummary } from "../../../../src/app/summarization/synthesizer.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SourceSummary } from "../../../../src/app/summarization/summarizer.js";

const mockSourceSummaries: SourceSummary[] = [
  {
    url: "https://example.com/a",
    title: "TypeScript Guide",
    keyTakeaways:
      "Enable strict mode in tsconfig.json for better type safety. Use path aliases to avoid deeply nested imports.",
    relevance: 0.9,
    tags: ["typescript"],
    language: "en",
  },
  {
    url: "https://example.com/b",
    title: "Node.js Practices",
    keyTakeaways:
      "Use async/await consistently for better error handling. Prefer native ES modules over CommonJS for modern projects.",
    relevance: 0.7,
    tags: ["nodejs"],
    language: "en",
  },
  {
    url: "https://example.com/c",
    title: "Irrelevant source",
    keyTakeaways: "No relevant information found.",
    relevance: 0.1,
    tags: [],
    language: "en",
  },
];

const MOCK_SYNTHESIS = {
  synthesizedSummary:
    "TypeScript and Node.js development benefits greatly from strict type checking and modern module systems. " +
    "Enabling strict mode in tsconfig.json catches many common bugs at compile time, while path aliases " +
    "improve code organization significantly. On the Node.js side, consistent use of async/await simplifies " +
    "error handling patterns, and adopting native ES modules positions projects for long-term compatibility.",
  keyFindings: [
    "Enable strict mode in tsconfig.json for comprehensive type safety",
    "Use path aliases to avoid deeply nested relative imports",
    "Prefer async/await consistently for better error handling",
  ],
  limitations: ["Sources focused primarily on configuration, not runtime patterns"],
};

describe("synthesizeSummary", () => {
  beforeEach(() => setLogSilent(true));
  afterEach(() => setLogSilent(false));

  it("synthesizes relevant sources into a unified report", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(MOCK_SYNTHESIS);
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    const result = await synthesizeSummary(
      "TypeScript best practices",
      mockSourceSummaries,
      mockChatModel,
    );

    expect(result.synthesizedSummary).toContain("strict mode");
    expect(result.keyFindings).toHaveLength(3);
    expect(result.limitations).toHaveLength(1);
  });

  it("filters out low-relevance sources from synthesis input", async () => {
    const mockInvoke = vi.fn().mockResolvedValue(MOCK_SYNTHESIS);
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    await synthesizeSummary("TypeScript best practices", mockSourceSummaries, mockChatModel);

    // The invoke call should only receive 2 relevant sources (not the 0.1 relevance one)
    const invokeArgs = mockInvoke.mock.calls[0] as unknown[];
    const messages = invokeArgs[0] as Array<{ content: string }>;
    const humanMsg = messages[1]!.content;
    expect(humanMsg).toContain("2 relevant");
    expect(humanMsg).not.toContain("No relevant information found");
  });

  it("returns fallback when no sources have sufficient relevance", async () => {
    const lowRelevanceSources: SourceSummary[] = mockSourceSummaries.map((s) => ({
      ...s,
      relevance: 0.1,
    }));

    const mockChatModel = {
      withStructuredOutput: vi.fn(),
    } as unknown as BaseChatModel;

    const result = await synthesizeSummary(
      "TypeScript best practices",
      lowRelevanceSources,
      mockChatModel,
    );

    expect(result.synthesizedSummary).toContain("No sufficiently relevant sources");
    expect(result.keyFindings).toEqual([]);
    expect(result.limitations).toHaveLength(1);
  });

  it("re-throws on LLM failure for caller to handle", async () => {
    const mockInvoke = vi.fn().mockRejectedValue(new Error("LLM timeout"));
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    await expect(
      synthesizeSummary("TypeScript best practices", mockSourceSummaries, mockChatModel),
    ).rejects.toThrow("LLM timeout");
  });
});
