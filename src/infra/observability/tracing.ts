export interface LogContext {
  traceId?: string | undefined;
  researchId?: string | undefined;
  node?: string | undefined;
  errorCode?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  [key: string]: unknown;
}

export interface StructuredLog {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  ts: string;
  [key: string]: unknown;
}

/** Pluggable log writer. Override with `setLogWriter` to route structured logs externally. */
let _writer: (json: string) => void = (json) => console.log(json);

/** Replace the default `console.log` writer with a custom sink. */
export function setLogWriter(writer: (json: string) => void): void {
  _writer = writer;
}

/** When true, all structured logging is suppressed (useful in tests). */
let _silent = false;
export function setLogSilent(value: boolean): void {
  _silent = value;
}

/** Numeric log level ordering for filtering (lower = more verbose). */
const LOG_LEVEL_ORDER: Record<StructuredLog["level"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** The minimum log level to emit. Messages below this level are suppressed. */
let _minLevel: StructuredLog["level"] = "info";
let _levelInitialized = false;

/** Set the minimum log level (e.g. from env config). */
export function setLogLevel(level: StructuredLog["level"]): void {
  _minLevel = level;
  _levelInitialized = true;
}

/**
 * Emits structured JSON logs for observability. Use traceId for correlation across nodes.
 */
export function log(level: StructuredLog["level"], msg: string, context: LogContext = {}): void {
  if (_silent) return;
  if (!_levelInitialized) {
    _levelInitialized = true;
    const envLevel = process.env["LOG_LEVEL"];
    if (envLevel && envLevel in LOG_LEVEL_ORDER) {
      _minLevel = envLevel as StructuredLog["level"];
    }
  }
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[_minLevel]) return;
  const entry: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
  };
  for (const [k, v] of Object.entries(context)) {
    if (v !== undefined) entry[k] = v;
  }
  _writer(JSON.stringify(entry));
}

export function logInfo(msg: string, context?: LogContext): void {
  log("info", msg, context);
}

export function logWarn(msg: string, context?: LogContext): void {
  log("warn", msg, context);
}

export function logError(msg: string, context?: LogContext): void {
  log("error", msg, context);
}

export function logDebug(msg: string, context?: LogContext): void {
  log("debug", msg, context);
}

export const ErrorCodes = {
  RESEARCH_NOT_FOUND: "RMS_RESEARCH_NOT_FOUND",
  INVALID_INPUT: "RMS_INVALID_INPUT",
  SEARCH_FAILED: "RMS_SEARCH_FAILED",
  SUMMARIZATION_FAILED: "RMS_SUMMARIZATION_FAILED",
  INFRA_RETRIABLE: "RMS_INFRA_RETRIABLE",
  STALE_CACHE: "RMS_STALE_CACHE",
} as const;

export async function withNodeTiming<T>(
  node: string,
  traceId: string | undefined,
  researchId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const start = Date.now();
  logDebug("Node start", { node, traceId, researchId });
  try {
    const out = await fn();
    logInfo("Node complete", { node, traceId, researchId, durationMs: Date.now() - start });
    return out;
  } catch (err) {
    logError("Node failed", {
      node,
      traceId,
      researchId,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
