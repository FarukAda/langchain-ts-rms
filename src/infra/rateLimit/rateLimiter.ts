import { logDebug } from "../observability/tracing.js";

// ---------------------------------------------------------------------------
// Token Bucket Rate Limiter
// ---------------------------------------------------------------------------

/**
 * In-process token bucket rate limiter — no external dependencies.
 *
 * Allows short bursts up to `maxTokens` while maintaining a steady-state
 * throughput of `refillRatePerSecond`. Callers that exceed the budget are
 * queued and resolved in FIFO order.
 *
 * @example
 * ```ts
 * const limiter = new TokenBucketLimiter(5, 2); // 5 burst, 2/sec refill
 * await limiter.acquire(); // wait until a token is available
 * ```
 */
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    private readonly maxTokens: number,
    private readonly refillRatePerSecond: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time since last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRatePerSecond;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait for a token to become available
    const waitMs = ((1 - this.tokens) / this.refillRatePerSecond) * 1000;
    logDebug("Rate limiter queued", { waitMs: Math.round(waitMs) });

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);

      setTimeout(() => {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
        }
        // Resolve the first queued waiter
        const waiter = this.waitQueue.shift();
        if (waiter) waiter();
      }, waitMs);
    });
  }

  /** Current number of available tokens (for testing/diagnostics). */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// ---------------------------------------------------------------------------
// Pre-configured limiters for RMS infrastructure services
// ---------------------------------------------------------------------------

/** Creates a new search rate limiter instance (for DI or testing). */
export function createSearchLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(5, 2);
}

/** Creates a new content extraction rate limiter instance (for DI or testing). */
export function createContentLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(3, 1);
}

/**
 * SearxNG rate limiter: 5 burst, 2/sec refill.
 * Prevents overwhelming the meta-search engine with rapid concurrent queries.
 */
export const searchLimiter = createSearchLimiter();

/**
 * Content extraction rate limiter: 3 burst, 1/sec refill.
 * Prevents target websites from IP-blocking the research bot.
 */
export const contentLimiter = createContentLimiter();
