import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { planSearchQueries } from "../../../../src/app/queryPlanning/planner.js";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

describe("planSearchQueries", () => {
  beforeEach(() => setLogSilent(true));
  afterEach(() => setLogSilent(false));

  it("returns LLM-generated queries from a subject", async () => {
    const mockInvoke = vi.fn().mockResolvedValueOnce({
      queries: ["LangGraph state management best practices", "LangGraph TypeScript tutorial 2025"],
    });
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    const queries = await planSearchQueries("How does LangGraph manage state?", mockChatModel);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("LangGraph");
    // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn() mock has no this binding
    expect(vi.mocked(mockChatModel.withStructuredOutput)).toHaveBeenCalledOnce();
  });

  it("falls back to raw subject when LLM call fails", async () => {
    const mockInvoke = vi.fn().mockRejectedValueOnce(new Error("LLM timeout"));
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    const queries = await planSearchQueries("AI safety research", mockChatModel);

    expect(queries).toEqual(["AI safety research"]);
  });

  it("falls back to raw subject when LLM returns empty queries", async () => {
    const mockInvoke = vi.fn().mockResolvedValueOnce({
      queries: ["", "  "],
    });
    const mockChatModel = {
      withStructuredOutput: vi.fn().mockReturnValue({ invoke: mockInvoke }),
    } as unknown as BaseChatModel;

    const queries = await planSearchQueries("AI safety research", mockChatModel);

    expect(queries).toEqual(["AI safety research"]);
  });
});
