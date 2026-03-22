import * as cheerio from "cheerio";
import { extract as articleExtract } from "@extractus/article-extractor";
import { logInfo, logWarn, logDebug } from "../observability/tracing.js";
import { contentLimiter, type TokenBucketLimiter } from "../rateLimit/rateLimiter.js";
import { contentBreaker, type CircuitBreaker } from "../rateLimit/circuitBreaker.js";
import { loadEnv } from "../../config/env.js";

/** Which extraction tier produced the content. */
export type ExtractionMethod = "article-extractor" | "cheerio" | "snippet";

/** Result of content extraction from a URL. */
export interface ExtractedContent {
  /** Extracted readable text (or original snippet as fallback). */
  text: string;
  /** Length of extracted text in characters. */
  extractedLength: number;
  /** True if full page content was fetched; false if fell back to snippet. */
  wasExtracted: boolean;
  /** Which extraction method produced this content. */
  extractionMethod: ExtractionMethod;
}

export interface ContentExtractionOptions {
  /** Max characters to extract per page (prevents blowing LLM context). */
  maxChars?: number;
  /** Request timeout per URL in milliseconds. */
  timeoutMs?: number;
  /** User-Agent header for HTTP requests. */
  userAgent?: string;
  /** Override the default content extraction rate limiter (for DI/testing). */
  limiter?: TokenBucketLimiter;
  /** Override the default content extraction circuit breaker (for DI/testing). */
  breaker?: CircuitBreaker;
}

/** Elements to strip before extracting text — not useful for research. */
const STRIP_SELECTORS = [
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
  "iframe",
  "noscript",
  ".sidebar",
  ".navigation",
  ".menu",
  ".ads",
  ".advertisement",
  ".cookie-banner",
  ".popup",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
];

/**
 * Extracts readable text content from an HTML page.
 *
 * Strips navigation, ads, scripts, and other non-content elements.
 * Collapses whitespace and truncates to `maxChars`.
 */
export function extractTextFromHtml(html: string, maxChars: number): string {
  const $ = cheerio.load(html);

  // Remove non-content elements
  for (const selector of STRIP_SELECTORS) {
    $(selector).remove();
  }

  // Prefer <article> or <main> if present; otherwise use <body>
  let contentRoot = $("article").first();
  if (contentRoot.length === 0) contentRoot = $("main").first();
  if (contentRoot.length === 0) contentRoot = $("body").first();

  // Get text, collapse whitespace
  const rawText = contentRoot.text();
  const cleaned = rawText
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned.slice(0, maxChars);
}

/**
 * Maximum number of bytes to download from a page before aborting.
 * Protects against bloated SPAs, PDFs, and other large payloads that would
 * cause OOM when fed to Cheerio. 100KB of HTML is more than enough for
 * article-length content.
 */
const MAX_DOWNLOAD_BYTES = 100_000;

/**
 * Realistic Chrome User-Agent string.
 * Using the bot-identifying UA caused widespread 403 blocks.
 */
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Minimum content length to consider an extraction successful (chars). */
const MIN_USEFUL_CONTENT_LENGTH = 200;

/**
 * Streams an HTTP response body, accumulating chunks into a string.
 * Aborts the request as soon as `maxBytes` is consumed, guaranteeing
 * bounded memory usage regardless of how large the remote payload is.
 */
async function streamWithByteLimit(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let accumulated = "";
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      accumulated += decoder.decode(value, { stream: true });

      if (totalBytes >= maxBytes) {
        logDebug("Byte limit reached, aborting stream", { totalBytes, maxBytes });
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => {
      /* best-effort cancellation */
    });
  }

  // Flush any remaining bytes in the decoder
  accumulated += decoder.decode();
  return accumulated;
}

/**
 * Primary extraction: uses `@extractus/article-extractor` which handles
 * its own HTTP fetch with smart content detection and boilerplate removal.
 * Returns clean text content or `null` if extraction fails.
 */
async function extractWithArticleExtractor(
  url: string,
  maxChars: number,
  userAgent: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const article = await articleExtract(
      url,
      {
        contentLengthThreshold: 100,
      },
      {
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!article?.content) {
      logInfo("Article extractor returned no content", { url });
      return null;
    }

    // article.content is HTML — strip tags to get plain text
    const $ = cheerio.load(article.content);
    const text = $.text()
      .replace(/\s+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxChars);

    if (text.length < MIN_USEFUL_CONTENT_LENGTH) {
      logInfo("Article extractor text too short", { url, length: text.length });
      return null;
    }

    logInfo("Article extractor succeeded", { url, extractedLength: text.length });
    return text;
  } catch (err) {
    logWarn("Article extractor failed", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Fetches a web page and extracts readable text content.
 *
 * Uses a tiered extraction strategy:
 * 1. `@extractus/article-extractor` — smart article detection with its own fetch
 * 2. Direct fetch + Cheerio — fallback HTML parsing pipeline
 * 3. SearXNG snippet — final fallback when both extraction methods fail
 *
 * Each tier only fires when the previous one didn't produce enough content.
 */
export async function extractContent(
  url: string,
  fallbackSnippet: string,
  options?: ContentExtractionOptions,
): Promise<ExtractedContent> {
  const maxChars = options?.maxChars ?? 8000;
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const userAgent = options?.userAgent ?? loadEnv().RMS_USER_AGENT ?? CHROME_USER_AGENT;

  const limiter = options?.limiter ?? contentLimiter;
  const breaker = options?.breaker ?? contentBreaker;

  // ── Tier 1: Article extractor (smart fetch + extraction) ──
  const articleText = await extractWithArticleExtractor(url, maxChars, userAgent, timeoutMs);
  if (articleText) {
    logInfo("Content extracted via article-extractor", {
      url,
      extractedLength: articleText.length,
    });
    return {
      text: articleText,
      extractedLength: articleText.length,
      wasExtracted: true,
      extractionMethod: "article-extractor",
    };
  }

  // ── Tier 2: Direct fetch + Cheerio (existing pipeline) ──
  try {
    await limiter.acquire();
    const resp = await breaker.execute(() =>
      fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      }),
    );

    if (!resp.ok) {
      logInfo("Content fetch returned non-OK status", { url, status: resp.status });
      return {
        text: fallbackSnippet,
        extractedLength: fallbackSnippet.length,
        wasExtracted: false,
        extractionMethod: "snippet",
      };
    }

    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      logInfo("Non-HTML content type, using snippet fallback", { url, contentType });
      return {
        text: fallbackSnippet,
        extractedLength: fallbackSnippet.length,
        wasExtracted: false,
        extractionMethod: "snippet",
      };
    }

    if (!resp.body) {
      logInfo("Response has no body, using snippet fallback", { url });
      return {
        text: fallbackSnippet,
        extractedLength: fallbackSnippet.length,
        wasExtracted: false,
        extractionMethod: "snippet",
      };
    }

    // Stream the response with a byte limit instead of downloading the full payload
    const html = await streamWithByteLimit(resp.body, MAX_DOWNLOAD_BYTES);
    const text = extractTextFromHtml(html, maxChars);

    // If extracted text is too short, the page might be JS-rendered — fall back
    if (text.length < 100) {
      logInfo("Cheerio extracted content too short, using snippet fallback", {
        url,
        extractedLength: text.length,
      });
      return {
        text: fallbackSnippet,
        extractedLength: fallbackSnippet.length,
        wasExtracted: false,
        extractionMethod: "snippet",
      };
    }

    logInfo("Content extracted via cheerio", { url, extractedLength: text.length });
    return { text, extractedLength: text.length, wasExtracted: true, extractionMethod: "cheerio" };
  } catch (err) {
    logWarn("Cheerio extraction failed, using snippet fallback", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      text: fallbackSnippet,
      extractedLength: fallbackSnippet.length,
      wasExtracted: false,
      extractionMethod: "snippet",
    };
  }
}

/**
 * Batch-extracts content from multiple URLs with concurrency limiting.
 *
 * Returns results in the same order as input URLs. Failed extractions
 * fall back to the provided snippets.
 */
export async function batchExtractContent(
  sources: Array<{ url: string; snippet: string }>,
  options?: ContentExtractionOptions & { concurrency?: number },
): Promise<ExtractedContent[]> {
  const concurrency = options?.concurrency ?? 3;
  const results: ExtractedContent[] = Array.from<ExtractedContent>({ length: sources.length });

  logInfo("Batch content extraction starting", {
    node: "contentExtractor",
    sourceCount: sources.length,
    concurrency,
  });

  // Process in batches of `concurrency`
  for (let i = 0; i < sources.length; i += concurrency) {
    const batch = sources.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((s) => extractContent(s.url, s.snippet, options)),
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j]!;
    }

    // Delay between batches to avoid IP-level throttling by target websites
    if (i + concurrency < sources.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  const methodCounts = { "article-extractor": 0, cheerio: 0, snippet: 0 };
  for (const r of results) {
    methodCounts[r.extractionMethod]++;
  }
  logInfo("Batch content extraction complete", {
    node: "contentExtractor",
    total: sources.length,
    articleExtractor: methodCounts["article-extractor"],
    cheerio: methodCounts.cheerio,
    snippet: methodCounts.snippet,
  });

  // Per-URL breakdown for debugging extraction quality
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const s = sources[i]!;
    logInfo(`Extraction result [${String(i + 1)}/${String(sources.length)}]`, {
      url: s.url,
      method: r.extractionMethod,
      extractedLength: r.extractedLength,
      wasExtracted: r.wasExtracted,
    });
  }

  return results;
}
