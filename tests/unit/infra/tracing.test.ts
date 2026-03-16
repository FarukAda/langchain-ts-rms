import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  logInfo,
  logWarn,
  logError,
  logDebug,
  setLogWriter,
  setLogSilent,
  setLogLevel,
  withNodeTiming,
  ErrorCodes,
} from "../../../src/infra/observability/tracing.js";

describe("structured logging", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    setLogWriter((json) => captured.push(json));
    setLogSilent(false);
    setLogLevel("debug");
  });

  afterEach(() => {
    setLogSilent(false);
    setLogLevel("info");
  });

  it("emits structured JSON with level, msg, ts", () => {
    logInfo("test message");
    expect(captured).toHaveLength(1);
    const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(entry["level"]).toBe("info");
    expect(entry["msg"]).toBe("test message");
    expect(entry["ts"]).toBeDefined();
  });

  it("includes context fields in output", () => {
    logInfo("with context", { traceId: "t1", researchId: "r1", node: "test" });
    const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(entry["traceId"]).toBe("t1");
    expect(entry["researchId"]).toBe("r1");
    expect(entry["node"]).toBe("test");
  });

  it("omits undefined context values", () => {
    logInfo("sparse", { traceId: undefined, researchId: "r1" });
    const entry = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect("traceId" in entry).toBe(false);
    expect(entry["researchId"]).toBe("r1");
  });

  it("respects log level filtering", () => {
    setLogLevel("warn");
    logDebug("should be filtered");
    logInfo("should be filtered too");
    logWarn("should appear");
    logError("should also appear");
    expect(captured).toHaveLength(2);
  });

  it("suppresses all logs when silent", () => {
    setLogSilent(true);
    logInfo("silenced");
    logError("also silenced");
    expect(captured).toHaveLength(0);
  });

  it("log helpers emit correct levels", () => {
    logDebug("d");
    logInfo("i");
    logWarn("w");
    logError("e");
    const levels = captured.map((c) => (JSON.parse(c) as Record<string, unknown>)["level"]);
    expect(levels).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("ErrorCodes", () => {
  it("has expected error code constants", () => {
    expect(ErrorCodes.RESEARCH_NOT_FOUND).toBe("RMS_RESEARCH_NOT_FOUND");
    expect(ErrorCodes.INVALID_INPUT).toBe("RMS_INVALID_INPUT");
    expect(ErrorCodes.SEARCH_FAILED).toBe("RMS_SEARCH_FAILED");
    expect(ErrorCodes.SUMMARIZATION_FAILED).toBe("RMS_SUMMARIZATION_FAILED");
    expect(ErrorCodes.INFRA_RETRIABLE).toBe("RMS_INFRA_RETRIABLE");
    expect(ErrorCodes.STALE_CACHE).toBe("RMS_STALE_CACHE");
  });
});

describe("withNodeTiming", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    setLogWriter((json) => captured.push(json));
    setLogSilent(false);
    setLogLevel("debug");
  });

  it("returns function result on success", async () => {
    const result = await withNodeTiming("test", "t1", "r1", () => 42);
    expect(result).toBe(42);
  });

  it("logs start and complete on success", async () => {
    await withNodeTiming("test", "t1", "r1", () => "ok");
    const entries = captured.map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(entries.some((e) => e["msg"] === "Node start")).toBe(true);
    expect(entries.some((e) => e["msg"] === "Node complete")).toBe(true);
  });

  it("logs start and failed on error", async () => {
    await expect(
      withNodeTiming("test", "t1", "r1", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const entries = captured.map((c) => JSON.parse(c) as Record<string, unknown>);
    expect(entries.some((e) => e["msg"] === "Node failed")).toBe(true);
  });

  it("includes durationMs in completion log", async () => {
    await withNodeTiming("test", "t1", "r1", () => "ok");
    const entries = captured.map((c) => JSON.parse(c) as Record<string, unknown>);
    const complete = entries.find((e) => e["msg"] === "Node complete");
    expect(complete?.["durationMs"]).toBeTypeOf("number");
  });
});
