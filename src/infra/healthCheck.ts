import { loadEnv } from "../config/env.js";
import { logInfo, logError } from "./observability/tracing.js";

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

/** Health status for a single backend service. */
export interface ServiceHealth {
  ok: boolean;
  latencyMs: number;
  error?: string | undefined;
}

/** Aggregate health status for all RMS backend dependencies. */
export interface HealthStatus {
  qdrant: ServiceHealth;
  ollama: ServiceHealth;
  searxng: ServiceHealth;
}

/**
 * Non-destructive health check for all RMS backend services.
 *
 * - **Qdrant**: calls `GET /collections`
 * - **Ollama**: calls `GET /api/tags`
 * - **SearxNG**: calls `GET /`
 *
 * @returns Structured health status with per-service latency.
 */
export async function checkHealth(): Promise<HealthStatus> {
  const env = loadEnv();

  const probe = async (url: string): Promise<ServiceHealth> => {
    const start = Date.now();
    try {
      const resp = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      if (!resp.ok) {
        return { ok: false, latencyMs, error: `HTTP ${resp.status}` };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const [qdrant, ollama, searxng] = await Promise.all([
    probe(`${env.QDRANT_URL}/collections`),
    probe(`${env.OLLAMA_HOST}/api/tags`),
    probe(`${env.SEARXNG_API_BASE}/`),
  ]);

  const allOk = qdrant.ok && ollama.ok && searxng.ok;
  if (allOk) {
    logInfo("Health check passed", {
      qdrantMs: qdrant.latencyMs,
      ollamaMs: ollama.latencyMs,
      searxngMs: searxng.latencyMs,
    });
  } else {
    logError("Health check failed", {
      qdrant: qdrant.ok ? "ok" : qdrant.error,
      ollama: ollama.ok ? "ok" : ollama.error,
      searxng: searxng.ok ? "ok" : searxng.error,
    });
  }

  return { qdrant, ollama, searxng };
}
