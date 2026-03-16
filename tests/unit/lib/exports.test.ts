import { describe, it, expect } from "vitest";
import {
  createResearchTool,
  createRmsLifecycleTools,
  checkGuardrail,
  evaluateGuardrails,
  requiresHumanApproval,
  evaluateFreshness,
  summarizeSearchResults,
  planSearchQueries,
  ResearchSchema,
  SourceSummarySchema,
  buildResearch,
  buildCompositeSummary,
  isResearchFresh,
  calculateExpiresAt,
  mergeResearchMetadata,
  getResearchAge,
  getResearchAgeDays,
  stripNulls,
  normalizeInput,
  paginate,
  wrapToolResponse,
  matchesFilters,
  RESEARCH_COLLECTION,
  ResearchRepository,
  loadEnv,
  resetEnv,
  DEFAULT_FORBIDDEN_PATTERNS,
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_MIN_CONFIDENCE,
  SourceSummaryOutputSchema,
  BatchSummaryOutputSchema,
  RmsStateAnnotation,
  createRmsWorkflow,
} from "../../../src/lib/index.js";

describe("barrel exports (index.ts)", () => {
  it("exports workflow factory", () => {
    expect(typeof createRmsWorkflow).toBe("function");
  });

  it("exports StateAnnotation", () => {
    expect(RmsStateAnnotation).toBeDefined();
  });

  it("exports SourceSummaryOutputSchema", () => {
    expect(SourceSummaryOutputSchema).toBeDefined();
  });

  it("exports SourceSummarySchema (domain)", () => {
    expect(SourceSummarySchema).toBeDefined();
  });

  it("exports guardrail functions", () => {
    expect(typeof checkGuardrail).toBe("function");
    expect(typeof evaluateGuardrails).toBe("function");
    expect(typeof requiresHumanApproval).toBe("function");
  });

  it("exports guardrail constants", () => {
    expect(Array.isArray(DEFAULT_FORBIDDEN_PATTERNS)).toBe(true);
    expect(typeof DEFAULT_MAX_SEARCH_COUNT).toBe("number");
    expect(typeof DEFAULT_MIN_CONFIDENCE).toBe("number");
  });

  it("exports core logic", () => {
    expect(typeof evaluateFreshness).toBe("function");
    expect(typeof summarizeSearchResults).toBe("function");
    expect(typeof planSearchQueries).toBe("function");
  });

  it("exports BatchSummaryOutputSchema", () => {
    expect(BatchSummaryOutputSchema).toBeDefined();
  });

  it("exports domain utilities", () => {
    expect(typeof buildResearch).toBe("function");
    expect(typeof buildCompositeSummary).toBe("function");
    expect(typeof isResearchFresh).toBe("function");
    expect(typeof calculateExpiresAt).toBe("function");
    expect(typeof mergeResearchMetadata).toBe("function");
    expect(typeof getResearchAge).toBe("function");
    expect(typeof getResearchAgeDays).toBe("function");
  });

  it("exports tool factories", () => {
    expect(typeof createResearchTool).toBe("function");
    expect(typeof createRmsLifecycleTools).toBe("function");
  });

  it("exports helper functions", () => {
    expect(typeof stripNulls).toBe("function");
    expect(typeof normalizeInput).toBe("function");
    expect(typeof paginate).toBe("function");
    expect(typeof wrapToolResponse).toBe("function");
    expect(typeof matchesFilters).toBe("function");
  });

  it("exports infra symbols", () => {
    expect(RESEARCH_COLLECTION).toBe("rms_research");
    expect(typeof ResearchRepository).toBe("function");
    expect(typeof loadEnv).toBe("function");
    expect(typeof resetEnv).toBe("function");
  });

  it("exports domain schema", () => {
    expect(ResearchSchema).toBeDefined();
  });
});
