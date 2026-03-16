import { describe, it, expect } from "vitest";
import { SynthesisOutputSchema } from "../../../../src/app/summarization/synthesisSchema.js";

describe("SynthesisOutputSchema", () => {
  it("validates a complete synthesis output", () => {
    const valid = {
      synthesizedSummary:
        "TypeScript development with Node.js benefits from strict typing, ES module support, " +
        "and modern configuration practices. These findings represent the consensus across " +
        "multiple authoritative sources on effective TypeScript development patterns.",
      keyFindings: ["Enable strict mode in tsconfig.json", "Use path aliases for clean imports"],
      limitations: ["Focus limited to backend patterns"],
    };

    const result = SynthesisOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts synthesis with short summary (no min constraint)", () => {
    const input = {
      synthesizedSummary: "Short but valid",
      keyFindings: ["Finding 1"],
      limitations: [],
    };

    const result = SynthesisOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts synthesis with empty keyFindings (no min constraint)", () => {
    const input = {
      synthesizedSummary: "A".repeat(250),
      keyFindings: [],
      limitations: [],
    };

    const result = SynthesisOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("defaults limitations to empty array", () => {
    const input = {
      synthesizedSummary: "A".repeat(250),
      keyFindings: ["Key finding 1"],
    };

    const result = SynthesisOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limitations).toEqual([]);
    }
  });
});
