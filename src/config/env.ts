import { z } from "zod/v4";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  QDRANT_URL: z.url().default("http://localhost:6333"),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  OLLAMA_HOST: z.url().default("http://localhost:11434"),
  OLLAMA_EMBEDDING_MODEL: z.string().default("bge-m3"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen3:8b"),
  RMS_OLLAMA_EMBEDDING_MODEL: z.string().optional(),
  RMS_OLLAMA_CHAT_MODEL: z.string().optional(),
  RMS_OLLAMA_NUM_CTX: z.coerce.number().int().positive().default(16384),

  SEARXNG_API_BASE: z.url().default("http://localhost:8080"),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_LANGUAGE: z.string().optional(),
  SEARXNG_TIME_RANGE: z.string().optional(),
  /** Comma-separated list of additional domains to block from search results. */
  SEARXNG_URL_BLOCKLIST: z.string().optional(),
  RMS_FRESHNESS_DAYS: z.coerce.number().int().positive().default(7),

  /** Zod v4 codec: coerces env string "true"/"false" → boolean. */
  LANGCHAIN_TRACING_V2: z.stringbool().default(false),
  LANGCHAIN_API_KEY: z.string().optional(),
  RMS_MCP_AUTH_TOKEN: z.string().optional(),
  RMS_USER_AGENT: z.string().optional(),
  /** Checkpointer backend: "memory" (default, dev only) or "sqlite" (durable, for HITL). */
  RMS_CHECKPOINTER: z.enum(["memory", "sqlite"]).default("memory"),
  /** SQLite file path for the checkpoint database (when RMS_CHECKPOINTER=sqlite). */
  RMS_CHECKPOINT_DB: z.string().default("rms_checkpoints.db"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/** Reset cached env (for tests only) */
export function resetEnv(): void {
  _env = null;
}

/**
 * Loads and validates environment variables (cached after first call).
 * @note In tests, call `resetEnv()` before each test to avoid stale cached values
 *       from bleeding into subsequent test cases.
 */
export function loadEnv(): Env {
  if (_env) return _env;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((e) => `${e.path.map(String).join(".")}: ${e.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  _env = parsed.data;
  return _env;
}
