import { logWarn, logInfo } from "../observability/tracing.js";

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

/** Circuit breaker states. */
type CircuitState = "closed" | "open" | "half_open";

/** Configuration for a CircuitBreaker instance. */
export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping to OPEN. Default: 5. */
  failureThreshold: number;
  /** Milliseconds to wait in OPEN before transitioning to HALF_OPEN. Default: 30000. */
  resetTimeMs: number;
  /** Human-readable name for logging. */
  name: string;
}

/**
 * In-process circuit breaker — no external dependencies.
 *
 * Three states:
 * - **CLOSED**: Normal operation. Failures are counted.
 * - **OPEN**: Fast-fail. After `failureThreshold` consecutive failures, all calls
 *   are rejected immediately without executing `fn`.
 * - **HALF_OPEN**: After `resetTimeMs`, one probe request is allowed through.
 *   On success → CLOSED. On failure → OPEN again.
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeMs: 30_000, name: "searxng" });
 * const result = await breaker.execute(() => fetch(url));
 * ```
 */
export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /** Current state (for diagnostics/testing). */
  get state(): CircuitState {
    return this._state;
  }

  /** Wraps an async operation with circuit breaker logic. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === "open") {
      // Check if enough time has passed to try a probe
      if (Date.now() - this.lastFailureTime >= this.opts.resetTimeMs) {
        this._state = "half_open";
        logInfo(`Circuit breaker "${this.opts.name}" → HALF_OPEN (probe allowed)`);
      } else {
        throw new Error(
          `Circuit breaker "${this.opts.name}" is OPEN — rejecting request. ` +
            `${this.consecutiveFailures} consecutive failures. ` +
            `Will retry after ${this.opts.resetTimeMs}ms cooldown.`,
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this._state === "half_open") {
      logInfo(`Circuit breaker "${this.opts.name}" → CLOSED (probe succeeded)`);
    }
    this._state = "closed";
    this.consecutiveFailures = 0;
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this._state = "open";
      logWarn(
        `Circuit breaker "${this.opts.name}" → OPEN after ${this.consecutiveFailures} failures`,
      );
    }
  }

  /** Reset the breaker to CLOSED state (for testing). */
  reset(): void {
    this._state = "closed";
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}

// ---------------------------------------------------------------------------
// Pre-configured breakers for RMS infrastructure services
// ---------------------------------------------------------------------------

/**
 * SearxNG circuit breaker: trips after 5 consecutive failures, 30s cooldown.
 * Prevents burning time on a down meta-search engine.
 */
export const searchBreaker = new CircuitBreaker({
  failureThreshold: 5,
  resetTimeMs: 30_000,
  name: "searxng",
});

/**
 * Content extraction circuit breaker: trips after 8 failures, 60s cooldown.
 * Higher threshold because individual sites fail independently.
 */
export const contentBreaker = new CircuitBreaker({
  failureThreshold: 8,
  resetTimeMs: 60_000,
  name: "content-extraction",
});
