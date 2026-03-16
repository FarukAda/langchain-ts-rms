import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { SearxngSearchResult } from "../../infra/search/searxngClient.js";
import { logInfo, logWarn } from "../../infra/observability/tracing.js";
import { SourceSummaryOutputSchema } from "./summarizationSchema.js";
import type { SourceSummaryOutput } from "./summarizationSchema.js";
import { batchExtractContent } from "../../infra/content/contentExtractor.js";
import type { ExtractionMethod } from "../../infra/content/contentExtractor.js";

// ── Public types ────────────────────────────────────────────────────

/** Per-source summary produced by the extraction step. */
export interface SourceSummary {
  url: string;
  title: string;
  keyTakeaways: string;
  relevance: number;
  tags: string[];
  language: string;
}

/** Per-URL extraction detail for debugging and verification. */
export interface ExtractionDetail {
  url: string;
  method: ExtractionMethod;
  extractedLength: number;
}

/** Aggregate output from `summarizeSearchResults()`, optionally enriched with synthesis. */
export interface SummarizationResult {
  sourceSummaries: SourceSummary[];
  overallConfidence: number;
  tags: string[];
  language: string;
  /** Per-URL extraction method breakdown for debugging. */
  extractionBreakdown: ExtractionDetail[];
  /** Synthesized multi-paragraph summary (produced by the synthesis step). */
  synthesizedSummary?: string | undefined;
  /** Key findings distilled from the research (produced by the synthesis step). */
  keyFindings?: string[] | undefined;
  /** Known gaps or limitations (produced by the synthesis step). */
  limitations?: string[] | undefined;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Normalizes tags: lowercase, replace spaces with hyphens, deduplicate, sort.
 * Ensures consistent tag format across all sources.
 */
export function normalizeTags(tags: string[]): string[] {
  const normalized = new Set(
    tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, "-")).filter((t) => t.length > 0),
  );
  return [...normalized].sort();
}

// ── Constants ────────────────────────────────────────────────────

/** Maximum characters of extracted content to include per source in the prompt. */
const MAX_CHARS_PER_SOURCE = 8000;

/** Minimum acceptable length for a keyTakeaways field (chars). Below this, retry once. */
const MIN_TAKEAWAY_LENGTH = 200;

// ── Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a research extraction assistant. Your takeaways feed into a synthesis step that produces a research report for developers.

Before extracting, consider: what specific facts does this source contribute, and what concrete details would a developer find actionable?

Guidelines:
1. Focus on facts, techniques, tools, numbers, and actionable insights relevant to the research subject.
2. Be concrete — include names, version numbers, code patterns, and configuration values.
3. Write substantive multi-paragraph extractions covering all noteworthy information.
4. If the source has no useful information, write "No relevant information found." and set relevance to 0.
5. Score relevance generously: 0.7-1.0 for on-topic sources, 0.4-0.7 for partially relevant, below 0.3 only for truly off-topic.`;

// ── Core logic ──────────────────────────────────────────────────────

/**
 * Summarizes a single source via a focused LLM call.
 *
 * If the LLM call fails or produces a thin takeaway, retries once with a
 * reinforced prompt. If both attempts fail, returns a degraded fallback
 * using the snippet.
 */
async function summarizeSingleSource(
  subject: string,
  searchResult: SearxngSearchResult,
  contentText: string,
  wasExtracted: boolean,
  sourceIndex: number,
  totalSources: number,
  chatModel: BaseChatModel,
): Promise<SourceSummary> {
  const contentLabel = wasExtracted ? "Full Page Content" : "Snippet";
  const truncatedText = contentText.slice(0, MAX_CHARS_PER_SOURCE);

  const humanMsg =
    `Research subject:\n<subject>\n${subject}\n</subject>\n\n` +
    `--- Source ---\n` +
    `Title: ${searchResult.title}\n` +
    `URL: ${searchResult.url}\n\n` +
    `<source_content type="${contentLabel}">\n${truncatedText}\n</source_content>\n\n` +
    `Extract key takeaways from this source.`;

  try {
    const structuredModel = chatModel.withStructuredOutput(SourceSummaryOutputSchema, {
      method: "jsonSchema",
      name: "source_summary",
    });

    let result: SourceSummaryOutput = await structuredModel.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(humanMsg),
    ]);

    // Quality gate: if takeaway is too thin, retry once with reinforced prompt
    if (result.keyTakeaways.trim().length < MIN_TAKEAWAY_LENGTH) {
      logWarn(`Source [${String(sourceIndex + 1)}/${String(totalSources)}] takeaway too thin, retrying`, {
        node: "summarizer",
        url: searchResult.url,
        takeawayLength: result.keyTakeaways.trim().length,
      });

      const retryMsg =
        humanMsg +
        "\n\nIMPORTANT: Your previous response had a very short takeaway. " +
        "Write a substantially longer extraction with much more detail. " +
        "Extract specific facts, version numbers, code patterns, and actionable advice from the source.";

      result = await structuredModel.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(retryMsg),
      ]);
    }

    logInfo(`Source [${String(sourceIndex + 1)}/${String(totalSources)}] summarized`, {
      node: "summarizer",
      url: searchResult.url,
      takeawayLength: result.keyTakeaways.trim().length,
      relevance: result.relevance,
    });

    return {
      url: searchResult.url,
      title: searchResult.title,
      keyTakeaways: result.keyTakeaways.trim(),
      relevance: Math.min(1, Math.max(0, result.relevance)),
      tags: result.tags,
      language: result.language,
    };
  } catch (err) {
    logWarn(`Source [${String(sourceIndex + 1)}/${String(totalSources)}] summarization failed, using degraded fallback`, {
      node: "summarizer",
      url: searchResult.url,
      error: err instanceof Error ? err.message : String(err),
    });

    // Degraded fallback: use the snippet as-is with zero relevance
    return {
      url: searchResult.url,
      title: searchResult.title,
      keyTakeaways: searchResult.snippet,
      relevance: 0,
      tags: [],
      language: "en",
    };
  }
}

/**
 * Summarizes search results by making ONE focused LLM call per source.
 *
 * Each source gets full page content extracted (when available, via streaming
 * with byte-limit protection) or falls back to SearXNG snippets. Content is
 * truncated to {@link MAX_CHARS_PER_SOURCE} chars per source.
 *
 * Individual source failures are isolated — a failed LLM call for one source
 * does not affect the others. Failed sources fall back to snippet-based
 * degraded entries with `relevance: 0`.
 */
export async function summarizeSearchResults(
  subject: string,
  searchResults: SearxngSearchResult[],
  chatModel: BaseChatModel,
): Promise<SummarizationResult> {
  logInfo("Summarizing results (per-source sequential)", {
    node: "summarizer",
    researchId: subject,
    sourceCount: searchResults.length,
  });

  if (searchResults.length === 0) {
    logWarn("No search results to summarize", {
      node: "summarizer",
      researchId: subject,
    });
    throw new Error("No search results to summarize");
  }

  // Extract full page content for all sources (with snippet fallback)
  const extractedContents = await batchExtractContent(
    searchResults.map((sr) => ({ url: sr.url, snippet: sr.snippet })),
  );

  // Build extraction breakdown for debugging
  const extractionBreakdown: ExtractionDetail[] = extractedContents.map((c, i) => ({
    url: searchResults[i]?.url ?? "",
    method: c.extractionMethod,
    extractedLength: c.extractedLength,
  }));

  // Process each source sequentially with its own focused LLM call
  const sourceSummaries: SourceSummary[] = [];
  for (let i = 0; i < searchResults.length; i++) {
    const sr = searchResults[i]!;
    const content = extractedContents[i]!;

    const summary = await summarizeSingleSource(
      subject,
      sr,
      content.text,
      content.wasExtracted,
      i,
      searchResults.length,
      chatModel,
    );
    sourceSummaries.push(summary);
  }

  const successCount = sourceSummaries.filter((s) => s.relevance > 0).length;
  logInfo("Per-source summarization complete", {
    node: "summarizer",
    researchId: subject,
    successCount,
    degradedCount: sourceSummaries.length - successCount,
    totalSources: searchResults.length,
  });

  return buildSummarizationResult(sourceSummaries, extractionBreakdown);
}

/**
 * Computes aggregate confidence, tags, and language from per-source summaries.
 */
function buildSummarizationResult(
  sourceSummaries: SourceSummary[],
  extractionBreakdown: ExtractionDetail[] = [],
): SummarizationResult {
  // Weighted confidence: only relevant sources count, weighted by relevance
  const relevantSources = sourceSummaries.filter((s) => s.relevance >= 0.3);
  const overallConfidence =
    relevantSources.length > 0
      ? Math.min(
          1,
          Math.max(
            0.1,
            relevantSources.reduce((sum, s) => sum + s.relevance, 0) / relevantSources.length,
          ),
        )
      : 0.1;

  const allTags = normalizeTags(sourceSummaries.flatMap((s) => s.tags));

  // Majority-vote language
  const langCounts = new Map<string, number>();
  for (const s of sourceSummaries) {
    langCounts.set(s.language, (langCounts.get(s.language) ?? 0) + 1);
  }
  const language = [...langCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";

  return {
    sourceSummaries,
    overallConfidence: Math.round(overallConfidence * 100) / 100,
    tags: allTags,
    language,
    extractionBreakdown,
  };
}
