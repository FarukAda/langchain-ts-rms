import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../../src/infra/observability/tracing.js";
import { CircuitBreaker } from "../../../../src/infra/rateLimit/circuitBreaker.js";

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("CircuitBreaker", () => {
  it("stays CLOSED when calls succeed", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeMs: 1000, name: "test" });
    const fn = vi.fn().mockResolvedValue("ok");

    await breaker.execute(fn);
    await breaker.execute(fn);

    expect(breaker.state).toBe("closed");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("trips to OPEN after failureThreshold consecutive failures", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeMs: 1000, name: "test" });
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow("fail");
    }

    expect(breaker.state).toBe("open");
  });

  it("rejects immediately in OPEN state without calling fn", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeMs: 60_000, name: "test" });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    const probeFn = vi.fn().mockResolvedValue("ok");

    // Trip the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("open");

    // Should reject without calling fn
    await expect(breaker.execute(probeFn)).rejects.toThrow("OPEN");
    expect(probeFn).not.toHaveBeenCalled();
  });

  it("transitions to HALF_OPEN after resetTimeMs", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeMs: 50, name: "test" });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    const successFn = vi.fn().mockResolvedValue("ok");

    // Trip the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("open");

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should allow one probe through
    const result = await breaker.execute(successFn);
    expect(result).toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("returns to OPEN on failed probe in HALF_OPEN", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeMs: 50, name: "test" });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));

    // Trip the breaker
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Probe fails → back to OPEN
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("open");
  });

  it("resets failure counter on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeMs: 1000, name: "test" });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));
    const successFn = vi.fn().mockResolvedValue("ok");

    // 2 failures (below threshold)
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("closed");

    // 1 success resets the counter
    await breaker.execute(successFn);
    expect(breaker.state).toBe("closed");

    // 2 more failures should not trip (counter was reset)
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("closed");
  });

  it("reset() returns to CLOSED state", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeMs: 1000, name: "test" });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    expect(breaker.state).toBe("open");

    breaker.reset();
    expect(breaker.state).toBe("closed");
  });

  it("includes breaker name in error message", async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeMs: 60_000,
      name: "my-service",
    });
    const failFn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(breaker.execute(failFn)).rejects.toThrow("fail");
    await expect(breaker.execute(failFn)).rejects.toThrow("my-service");
  });
});
