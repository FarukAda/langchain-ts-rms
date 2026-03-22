import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { SourceSummary } from "./summarizer.js";
import { SynthesisOutputSchema } from "./synthesisSchema.js";
import { logInfo, logWarn, logError, ErrorCodes } from "../../infra/observability/tracing.js";

// ── Public types ────────────────────────────────────────────────────

/** Result of synthesizing per-source takeaways into a unified report. */
export interface SynthesisResult {
  /** The synthesized multi-paragraph research summary. */
  synthesizedSummary: string;
  /** 3-7 crisp, actionable key findings. */
  keyFindings: string[];
  /** Known gaps or limitations in the research. */
  limitations: string[];
}

// ── Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior research analyst producing final research reports for developers and technical decision-makers.

Before writing, consider: what themes emerge across sources, and where do sources agree or contradict?

Guidelines:
1. Organize by theme, grouping related insights from different sources together.
2. Write flowing prose with exhaustive detail — specific facts, numbers, code patterns, and actionable advice.
3. Highlight consensus and contradictions across sources.
4. Synthesize into a unified narrative — the reader should not be aware of individual source boundaries.`;

/** Minimum relevance threshold for including a source in synthesis. */
const MIN_RELEVANCE_FOR_SYNTHESIS = 0.3;

// ── Core logic ──────────────────────────────────────────────────────

/**
 * Synthesizes per-source takeaways into a unified, theme-organized
 * research report using a single LLM call.
 *
 * Only sources with relevance ≥ 0.3 are included.
 * This produces a qualitatively superior summary compared to
 * simple concatenation of per-source takeaways.
 */
export async function synthesizeSummary(
  subject: string,
  sourceSummaries: SourceSummary[],
  chatModel: BaseChatModel,
): Promise<SynthesisResult> {
  const relevantSources = sourceSummaries.filter((s) => s.relevance >= MIN_RELEVANCE_FOR_SYNTHESIS);

  if (relevantSources.length === 0) {
    logWarn("No relevant sources for synthesis", {
      node: "synthesizer",
      researchId: subject,
      totalSources: sourceSummaries.length,
    });
    return {
      synthesizedSummary:
        "No sufficiently relevant sources were found to produce a research synthesis.",
      keyFindings: [],
      limitations: ["All sources had low relevance to the research subject."],
    };
  }

  logInfo("Synthesizing research summary", {
    node: "synthesizer",
    researchId: subject,
    relevantSources: relevantSources.length,
    totalSources: sourceSummaries.length,
  });

  const takeawaysBlock = relevantSources
    .map(
      (s, i) =>
        `[Source ${String(i + 1)}] (relevance: ${String(s.relevance)}, tags: ${s.tags.join(", ")})\n${s.keyTakeaways}`,
    )
    .join("\n\n");

  const humanMsg =
    `Research subject:\n<subject>\n${subject}\n</subject>\n\n` +
    `Total sources analyzed: ${String(sourceSummaries.length)} ` +
    `(${String(relevantSources.length)} relevant)\n\n` +
    `<source_takeaways>\n${takeawaysBlock}\n</source_takeaways>\n\n` +
    `Synthesize these takeaways into a comprehensive research report.`;

  try {
    const structuredModel = chatModel.withStructuredOutput(SynthesisOutputSchema, {
      method: "jsonSchema",
      name: "research_synthesis",
    });

    const result = await structuredModel.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(humanMsg),
    ]);

    logInfo("Synthesis complete", {
      node: "synthesizer",
      researchId: subject,
      summaryLength: result.synthesizedSummary.length,
      keyFindingsCount: result.keyFindings.length,
      limitationsCount: result.limitations?.length ?? 0,
    });

    return {
      synthesizedSummary: result.synthesizedSummary.trim(),
      keyFindings: result.keyFindings.map((f) => f.trim()),
      limitations: (result.limitations ?? []).map((l) => l.trim()),
    };
  } catch (err) {
    logError("Synthesis failed, returning fallback", {
      node: "synthesizer",
      researchId: subject,
      errorCode: ErrorCodes.SUMMARIZATION_FAILED,
      error: err instanceof Error ? err.message : String(err),
    });
    // Synthesis failure is non-fatal — caller falls back to composite summary
    throw err;
  }
}
