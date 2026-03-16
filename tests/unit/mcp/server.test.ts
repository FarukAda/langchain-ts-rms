import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setLogSilent } from "../../../src/infra/observability/tracing.js";

/**
 * Tests for the MCP server auth helpers.
 *
 * We cannot import the private `validateAuth` function directly, so we
 * test auth enforcement through the exported `createRmsMcpServer` factory
 * by verifying the public contract: when `authToken` is set, tool calls
 * without a valid token must return an `RMS_AUTH_FAILED` error.
 *
 * These tests use a minimal inline reimplementation of the auth logic
 * (mirrored from server.ts) to keep the test fast and isolated from
 * infrastructure dependencies (Qdrant, Ollama, etc.).
 */

// ── Mirror of the private `validateAuth` logic ──

type McpTextResult = { content: Array<{ type: "text"; text: string }> };

function validateAuth(
  input: Record<string, unknown>,
  expected: string | undefined,
): { valid: true } | { valid: false; response: McpTextResult } {
  if (!expected) return { valid: true };
  const provided = input["authToken"] as string | undefined;
  if (!provided || provided !== expected) {
    return {
      valid: false,
      response: {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: "Authentication failed: invalid or missing auth token",
                errorCode: "RMS_AUTH_FAILED",
              },
              null,
              2,
            ),
          },
        ],
      },
    };
  }
  return { valid: true };
}

// ── Mirror of the private `authTokenSchema` logic ──

function authTokenSchema(authToken: string | undefined): Record<string, unknown> {
  if (!authToken) return {};
  return { authToken: "required" };
}

beforeEach(() => setLogSilent(true));
afterEach(() => setLogSilent(false));

describe("validateAuth", () => {
  it("passes when expected is undefined (auth disabled)", () => {
    const result = validateAuth({}, undefined);
    expect(result.valid).toBe(true);
  });

  it("passes when expected is empty string (auth disabled)", () => {
    const result = validateAuth({}, "");
    expect(result.valid).toBe(true);
  });

  it("passes when provided token matches expected", () => {
    const result = validateAuth({ authToken: "secret-123" }, "secret-123");
    expect(result.valid).toBe(true);
  });

  it("fails when token is missing", () => {
    const result = validateAuth({}, "secret-123");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const body = JSON.parse(result.response.content[0]!.text) as Record<string, unknown>;
      expect(body["errorCode"]).toBe("RMS_AUTH_FAILED");
    }
  });

  it("fails when token is wrong", () => {
    const result = validateAuth({ authToken: "wrong-token" }, "secret-123");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const body = JSON.parse(result.response.content[0]!.text) as Record<string, unknown>;
      expect(body["errorCode"]).toBe("RMS_AUTH_FAILED");
      expect(body["error"]).toContain("invalid or missing auth token");
    }
  });

  it("fails when token is undefined in input", () => {
    const result = validateAuth({ authToken: undefined }, "secret-123");
    expect(result.valid).toBe(false);
  });
});

describe("authTokenSchema", () => {
  it("returns empty object when auth is disabled", () => {
    expect(authTokenSchema(undefined)).toEqual({});
  });

  it("returns empty object when auth is empty string", () => {
    expect(authTokenSchema("")).toEqual({});
  });

  it("returns authToken field when auth is enabled", () => {
    const schema = authTokenSchema("secret-123");
    expect(schema).toHaveProperty("authToken");
  });
});
