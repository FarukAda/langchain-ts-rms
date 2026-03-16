import { describe, it, expect } from "vitest";
import { SourceSummaryOutputSchema } from "../../../../src/app/summarization/summarizationSchema.js";

describe("SourceSummaryOutputSchema", () => {
  it("parses a valid complete object", () => {
    const result = SourceSummaryOutputSchema.parse({
      keyTakeaways:
        "LangChain provides a map-reduce summarization chain that splits documents into chunks, summarizes each chunk independently, and then combines them into a final summary. This approach handles documents of arbitrary length while maintaining coherent output. The chain supports configurable chunk sizes, overlap settings, and custom prompt templates for both the map and reduce stages, giving developers fine-grained control over the summarization pipeline.",
      relevance: 0.85,
      tags: ["langchain", "summarization"],
      language: "en",
    });

    expect(result.keyTakeaways).toContain("LangChain");
    expect(result.relevance).toBe(0.85);
    expect(result.tags).toEqual(["langchain", "summarization"]);
    expect(result.language).toBe("en");
  });

  it("applies defaults for optional fields", () => {
    const result = SourceSummaryOutputSchema.parse({
      keyTakeaways:
        "Structured output with Ollama requires method jsonSchema to pass schema descriptions to the model for reliable extraction. This approach ensures the LLM returns data in the expected format with proper field names and types. The method supports nested objects, arrays, enums, and optional fields, enabling complex structured data extraction from free-form text.",
    });

    expect(result.relevance).toBe(0.5);
    expect(result.tags).toEqual([]);
    expect(result.language).toBe("en");
  });

  it("rejects missing keyTakeaways", () => {
    expect(() =>
      SourceSummaryOutputSchema.parse({
        relevance: 0.5,
        tags: [],
        language: "en",
      }),
    ).toThrow();
  });

  it("rejects keyTakeaways shorter than 300 characters", () => {
    expect(() =>
      SourceSummaryOutputSchema.parse({
        keyTakeaways:
          "Too short to be useful. This sentence does not meet the minimum character threshold. Even with this extra text it still should not pass the validation gate because it does not reach the required three hundred characters.",
        relevance: 0.5,
      }),
    ).toThrow();
  });

  it("clamps relevance between 0 and 1", () => {
    expect(() =>
      SourceSummaryOutputSchema.parse({
        keyTakeaways:
          "Some valid takeaway text that is long enough to pass the minimum length requirement for the schema validation. This additional sentence ensures we exceed the 300-character threshold for proper testing. Adding more detail about configuration values and API patterns to make this even more realistic as a test fixture.",
        relevance: 1.5,
      }),
    ).toThrow();

    expect(() =>
      SourceSummaryOutputSchema.parse({
        keyTakeaways:
          "Some valid takeaway text that is long enough to pass the minimum length requirement for the schema validation. This additional sentence ensures we exceed the 300-character threshold for proper testing. Adding more detail about configuration values and API patterns to make this even more realistic as a test fixture.",
        relevance: -0.1,
      }),
    ).toThrow();
  });
});
