import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadEnv, resetEnv } from "../../../src/config/env.js";

describe("loadEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetEnv();
  });

  it("loads with all defaults when no env vars are set", () => {
    // Clear relevant env vars
    delete process.env["QDRANT_URL"];
    delete process.env["OLLAMA_HOST"];
    delete process.env["SEARXNG_API_BASE"];
    delete process.env["RMS_FRESHNESS_DAYS"];
    delete process.env["NODE_ENV"];
    delete process.env["LOG_LEVEL"];

    const env = loadEnv();
    expect(env.QDRANT_URL).toBe("http://localhost:6333");
    expect(env.OLLAMA_HOST).toBe("http://localhost:11434");
    expect(env.OLLAMA_EMBEDDING_MODEL).toBe("bge-m3");
    expect(env.OLLAMA_CHAT_MODEL).toBe("qwen3:8b");
    expect(env.SEARXNG_API_BASE).toBe("http://localhost:8080");
    expect(env.RMS_FRESHNESS_DAYS).toBe(7);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("overrides defaults from environment variables", () => {
    process.env["QDRANT_URL"] = "http://qdrant:6333";
    process.env["OLLAMA_HOST"] = "http://ollama:11434";
    process.env["SEARXNG_API_BASE"] = "http://searxng:8080";
    process.env["RMS_FRESHNESS_DAYS"] = "14";
    process.env["NODE_ENV"] = "test";
    process.env["LOG_LEVEL"] = "debug";

    const env = loadEnv();
    expect(env.QDRANT_URL).toBe("http://qdrant:6333");
    expect(env.OLLAMA_HOST).toBe("http://ollama:11434");
    expect(env.SEARXNG_API_BASE).toBe("http://searxng:8080");
    expect(env.RMS_FRESHNESS_DAYS).toBe(14);
    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("debug");
  });

  it("caches the result across multiple calls", () => {
    const env1 = loadEnv();
    const env2 = loadEnv();
    expect(env1).toBe(env2); // same reference
  });

  it("resets cache when resetEnv is called", () => {
    const env1 = loadEnv();
    resetEnv();
    process.env["LOG_LEVEL"] = "error";
    const env2 = loadEnv();
    expect(env2.LOG_LEVEL).toBe("error");
    expect(env1).not.toBe(env2);
  });

  it("returns RMS-specific model overrides when set", () => {
    process.env["RMS_OLLAMA_EMBEDDING_MODEL"] = "custom-embed";
    process.env["RMS_OLLAMA_CHAT_MODEL"] = "custom-chat";

    const env = loadEnv();
    expect(env.RMS_OLLAMA_EMBEDDING_MODEL).toBe("custom-embed");
    expect(env.RMS_OLLAMA_CHAT_MODEL).toBe("custom-chat");
  });

  it("throws on invalid NODE_ENV", () => {
    process.env["NODE_ENV"] = "invalid";
    expect(() => loadEnv()).toThrow("Invalid environment configuration");
  });

  it("throws on non-URL for QDRANT_URL", () => {
    process.env["QDRANT_URL"] = "not-a-url";
    expect(() => loadEnv()).toThrow("Invalid environment configuration");
  });
});
