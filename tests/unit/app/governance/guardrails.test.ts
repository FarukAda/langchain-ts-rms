import { describe, it, expect } from "vitest";
import {
  checkGuardrail,
  requiresHumanApproval,
  evaluateGuardrails,
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_MIN_CONFIDENCE,
} from "../../../../src/app/governance/guardrails.js";

describe("checkGuardrail", () => {
  it("allows safe research subjects", () => {
    const result = checkGuardrail("quantum computing");
    expect(result.allowed).toBe(true);
  });

  it("blocks subjects matching forbidden patterns", () => {
    const result = checkGuardrail("how to hack a server");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("how to hack");
    }
  });

  it("is case-insensitive", () => {
    const result = checkGuardrail("HOW TO HACK");
    expect(result.allowed).toBe(false);
  });

  it("uses custom forbidden patterns when provided", () => {
    const result = checkGuardrail("internal report", {
      forbiddenPatterns: ["internal report"],
    });
    expect(result.allowed).toBe(false);
  });

  it("allows subjects not in custom forbidden patterns", () => {
    const result = checkGuardrail("quantum computing", {
      forbiddenPatterns: ["internal report"],
    });
    expect(result.allowed).toBe(true);
  });

  it("exports default forbidden patterns", () => {
    expect(Array.isArray(DEFAULT_FORBIDDEN_PATTERNS)).toBe(true);
    expect(DEFAULT_FORBIDDEN_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("requiresHumanApproval", () => {
  it("does not require approval for small result counts", () => {
    expect(requiresHumanApproval(5)).toBe(false);
  });

  it("requires approval when result count exceeds max", () => {
    expect(requiresHumanApproval(DEFAULT_MAX_SEARCH_COUNT + 1)).toBe(true);
  });

  it("requires approval for low confidence scores", () => {
    expect(requiresHumanApproval(5, 0.1)).toBe(true);
  });

  it("does not require approval for adequate confidence", () => {
    expect(requiresHumanApproval(5, 0.8)).toBe(false);
  });

  it("uses custom max search count", () => {
    expect(requiresHumanApproval(6, undefined, { maxSearchCount: 5 })).toBe(true);
    expect(requiresHumanApproval(4, undefined, { maxSearchCount: 5 })).toBe(false);
  });

  it("uses custom min confidence", () => {
    expect(requiresHumanApproval(5, 0.4, { minConfidence: 0.5 })).toBe(true);
    expect(requiresHumanApproval(5, 0.6, { minConfidence: 0.5 })).toBe(false);
  });

  it("exports default constants", () => {
    expect(DEFAULT_MAX_SEARCH_COUNT).toBe(50);
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.3);
  });
});

describe("evaluateGuardrails", () => {
  it("returns allowed + no approval for safe subject with few results", () => {
    const result = evaluateGuardrails("quantum computing", 5);
    expect(result.check.allowed).toBe(true);
    expect(result.needsHumanApproval).toBe(false);
  });

  it("returns blocked + no approval for forbidden subject", () => {
    const result = evaluateGuardrails("how to hack", 5);
    expect(result.check.allowed).toBe(false);
    // When blocked, human approval is not needed (action is denied outright)
    expect(result.needsHumanApproval).toBe(false);
  });

  it("returns allowed + approval needed for excessive results", () => {
    const result = evaluateGuardrails("quantum computing", 100);
    expect(result.check.allowed).toBe(true);
    expect(result.needsHumanApproval).toBe(true);
  });

  it("returns allowed + approval needed for low confidence", () => {
    const result = evaluateGuardrails("quantum computing", 5, {}, {}, 0.1);
    expect(result.check.allowed).toBe(true);
    expect(result.needsHumanApproval).toBe(true);
  });
});
