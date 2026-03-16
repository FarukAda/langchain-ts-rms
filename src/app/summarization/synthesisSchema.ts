import { z } from "zod/v4";

/**
 * Schema for structured LLM output when synthesizing all per-source
 * takeaways into a unified research summary.
 *
 * Used with `chatModel.withStructuredOutput(SynthesisOutputSchema)`.
 * This is a single LLM call that receives all relevant takeaways
 * and produces a comprehensive, theme-organized research report.
 */
export const SynthesisOutputSchema = z.object({
  synthesizedSummary: z.string().meta({
    description:
      "A comprehensive research summary organized by themes (NOT by source). " +
      "Write 5-10 paragraphs covering: key concepts, practical techniques, " +
      "tools/frameworks mentioned, best practices, trade-offs, and implementation details. " +
      "Include specific facts, numbers, version references, code patterns, and actionable advice. " +
      "Go deep — write flowing prose.",
    examples: [
      "State management in LangGraph centers on the StateGraph API, introduced in v0.2 as a replacement for the legacy MessageGraph. " +
        "Persistence is handled through a pluggable checkpointer interface with MemorySaver for development and PostgresSaver for production.",
    ],
  }),
  keyFindings: z
    .array(z.string())
    .max(15)
    .meta({
      description:
        "5-15 crisp, actionable key findings distilled from the research. " +
        "Each finding should be a single sentence with specific details (names, versions, numbers). " +
        "Cover all major insights — do not artificially limit the count.",
      examples: [
        "TypeScript strict mode catches 15-20% more bugs at compile time",
        "Use path aliases in tsconfig.json to avoid deeply nested relative imports",
      ],
    }),
  limitations: z
    .array(z.string())
    .default([])
    .meta({
      description:
        "Known gaps, caveats, or limitations in the research. " +
        "E.g. 'Most sources focus on Node.js backend; frontend patterns are underrepresented.' " +
        "Leave empty if no significant limitations.",
    }),
});

export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;
