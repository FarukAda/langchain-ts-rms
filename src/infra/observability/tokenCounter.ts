import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";

// ---------------------------------------------------------------------------
// Token Usage Collector
// ---------------------------------------------------------------------------

/**
 * LangChain callback handler that accumulates LLM token usage across
 * multiple invocations within a single workflow run.
 *
 * Attach to chat model calls via `chatModel.bind({ callbacks: [collector] })`
 * or pass as part of the call options.
 *
 * @example
 * ```ts
 * const collector = new TokenUsageCollector();
 * await chatModel.invoke(messages, { callbacks: [collector] });
 * console.log(collector.usage); // { promptTokens: 512, completionTokens: 128 }
 * ```
 */
export class TokenUsageCollector extends BaseCallbackHandler {
  name = "TokenUsageCollector";

  private _promptTokens = 0;
  private _completionTokens = 0;

  override handleLLMEnd(output: LLMResult): void {
    // LangChain stores token usage in `llmOutput.tokenUsage` or
    // in the generation's `message.usage_metadata` depending on provider.
    // For Ollama via @langchain/ollama, usage is in `llmOutput.tokenUsage`.
    const usage = output.llmOutput as
      | { tokenUsage?: { promptTokens?: number; completionTokens?: number } }
      | undefined;

    if (usage?.tokenUsage) {
      this._promptTokens += usage.tokenUsage.promptTokens ?? 0;
      this._completionTokens += usage.tokenUsage.completionTokens ?? 0;
    }
  }

  /** Accumulated token usage from all LLM calls observed by this collector. */
  get usage(): { promptTokens: number; completionTokens: number } {
    return {
      promptTokens: this._promptTokens,
      completionTokens: this._completionTokens,
    };
  }

  /** Reset accumulated counters (for reuse across separate runs). */
  reset(): void {
    this._promptTokens = 0;
    this._completionTokens = 0;
  }
}
