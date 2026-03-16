/**
 * RMS Workflow Integration Tests
 *
 * Direct workflow-level tests that bypass the LLM agent loop.
 * Uses `conductResearchDirect()` and `streamResearch()` against live
 * Qdrant, Ollama, and SearXNG services for deterministic flow validation.
 *
 * Prerequisites:
 *   docker compose up -d qdrant searxng
 *   docker compose --profile ollama up -d ollama
 *   ollama pull nomic-embed-text && ollama pull qwen3:8b
 *
 * Run:
 *   npm run test:agent
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as allure from "allure-js-commons";
import { conductResearchDirect, streamResearch } from "../../src/lib/tools/research.js";
import type { RmsEvent } from "../../src/lib/tools/research.js";
import { ResearchRepository } from "../../src/infra/vector/researchRepository.js";
import { createEmbeddingProvider } from "../../src/infra/embeddings/embeddingProvider.js";
import { createChatModelProvider } from "../../src/infra/chat/chatModelProvider.js";
import {
  createQdrantClient,
  bootstrapQdrantCollections,
} from "../../src/infra/vector/qdrantClient.js";
import { checkHealth } from "../../src/infra/healthCheck.js";
import type { Research } from "../../src/domain/contracts.js";
import type { RmsToolDeps } from "../../src/lib/types.js";
import { setLogSilent } from "../../src/infra/observability/tracing.js";

// ── Guard: skip unless infra is available ───────────────────────────
const AGENT_TEST = process.env.RMS_AGENT_TEST === "1";

// ── Helpers ─────────────────────────────────────────────────────────

async function attachJson(name: string, data: unknown): Promise<void> {
  await allure.attachment(name, JSON.stringify(data, null, 2), "application/json");
}

async function attachText(name: string, text: string): Promise<void> {
  await allure.attachment(name, text, "text/plain");
}

// ── Test Suite ───────────────────────────────────────────────────────

describe.skipIf(!AGENT_TEST)("RMS Workflow Integration", () => {
  let deps: Omit<RmsToolDeps, "toolName" | "toolDescription">;
  let repo: ResearchRepository;

  // Track IDs for cleanup
  const createdIds: string[] = [];

  beforeAll(async () => {
    setLogSilent(true);

    process.env.RMS_TENANT_ID = "workflow-int-test";

    const qdrant = createQdrantClient();
    const embeddings = createEmbeddingProvider();
    const chatModel = createChatModelProvider();

    // Ensure collection exists
    const sampleVec = await embeddings.embedQuery("test");
    await bootstrapQdrantCollections(qdrant, sampleVec.length);

    repo = new ResearchRepository({ embeddings, client: qdrant });

    deps = {
      researchRepository: repo,
      embeddings,
      chatModel,
    };
  }, 120_000);

  afterAll(async () => {
    // Clean up all created research entries
    if (createdIds.length > 0) {
      try {
        await repo.deleteByIds(createdIds);
      } catch {
        // Best-effort cleanup
      }
    }
    setLogSilent(false);
  });

  // ── Test 0: Health Check (pre-flight) ─────────────────────────────

  it("all backend services are healthy", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Health Check");
    await allure.severity("blocker");

    const health = await checkHealth();

    await allure.step("Health check results", async () => {
      await attachJson("health_status", health);
    });

    expect(health.qdrant.ok, `Qdrant unhealthy: ${health.qdrant.error}`).toBe(true);
    expect(health.ollama.ok, `Ollama unhealthy: ${health.ollama.error}`).toBe(true);
    expect(health.searxng.ok, `SearxNG unhealthy: ${health.searxng.error}`).toBe(true);

    // Latency sanity check — all services should respond under 5s
    expect(health.qdrant.latencyMs).toBeLessThan(5000);
    expect(health.ollama.latencyMs).toBeLessThan(5000);
    expect(health.searxng.latencyMs).toBeLessThan(5000);
  }, 30_000);

  // ── Test 1: Full Research → Content Validation ────────────────────

  let firstResearch: Research | undefined;

  it("produces a complete research entry with valid content", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Full Research Flow");
    await allure.severity("critical");

    const subject = "TypeScript generics best practices";

    await allure.step("Invoke workflow", async () => {
      await attachText("subject", subject);
    });

    const result = await conductResearchDirect(
      { subject, tenantId: process.env.RMS_TENANT_ID },
      deps,
    );

    await allure.step("Workflow result", async () => {
      await attachJson("result", result);
    });

    // Always attach extraction quality data (even on failure) for debugging
    if ("extractionBreakdown" in result && result.extractionBreakdown) {
      await allure.step("Extraction quality breakdown", async () => {
        await attachJson("extraction_breakdown", result.extractionBreakdown);
        await attachText("confidence", String("confidence" in result ? result.confidence : "N/A"));
      });
    }

    // No error
    expect(
      "error" in result,
      `Workflow returned error: ${"error" in result ? String(result.error) : ""}`,
    ).toBe(false);

    // Type narrow after error check
    const { research, source } = result as {
      research: Research;
      source: string;
      wasRefreshed: boolean;
    };
    firstResearch = research;
    createdIds.push(research.id);

    // Structural assertions
    expect(research.id).toBeDefined();
    expect(research.subject).toBeDefined();
    expect(research.status).toBe("active");

    // Content quality assertions
    expect(research.summary.length, "Summary should be substantial").toBeGreaterThanOrEqual(200);
    expect(research.sourceUrls.length, "Should have ≥1 source URL").toBeGreaterThanOrEqual(1);
    expect(research.sourceSummaries.length, "Should have ≥1 source summary").toBeGreaterThanOrEqual(
      1,
    );
    expect(research.searchQueries.length, "Should have ≥2 planned queries").toBeGreaterThanOrEqual(
      2,
    );

    // Per-source takeaway quality
    for (const ss of research.sourceSummaries) {
      expect(
        typeof ss === "object" && ss !== null && "keyTakeaways" in ss,
        "Each source summary should have keyTakeaways",
      ).toBe(true);
      const takeaways = (ss as Record<string, unknown>).keyTakeaways;
      expect(
        typeof takeaways === "string" && takeaways.length > 50,
        "keyTakeaways should be detailed (>50 chars)",
      ).toBe(true);
    }

    // Key findings (from synthesis)
    if (research.keyFindings) {
      expect(research.keyFindings.length, "Should have ≥1 key finding").toBeGreaterThanOrEqual(1);
    }

    // Confidence
    expect(research.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(research.confidenceScore).toBeLessThanOrEqual(1);

    // Expiration (should be in the future)
    if (research.expiresAt) {
      expect(new Date(research.expiresAt).getTime()).toBeGreaterThan(Date.now());
    }

    // Source tracking
    expect(source).toBe("web");

    await allure.step("Content quality metrics", async () => {
      await attachJson("quality", {
        summaryLength: research.summary.length,
        sourceCount: research.sourceUrls.length,
        sourceSummaryCount: research.sourceSummaries.length,
        queryCount: research.searchQueries.length,
        keyFindingCount: research.keyFindings?.length ?? 0,
        confidence: research.confidenceScore,
      });
    });
  }, 600_000);

  // ── Test 2: Cache Hit Path ────────────────────────────────────────

  it("returns cached research for the same subject", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Cache Hit Flow");
    await allure.severity("critical");

    expect(firstResearch, "Test 1 must have created research").toBeDefined();

    const startMs = Date.now();
    const result = await conductResearchDirect(
      { subject: "TypeScript generics best practices", tenantId: process.env.RMS_TENANT_ID },
      deps,
    );
    const elapsedMs = Date.now() - startMs;

    await allure.step("Cache hit result", async () => {
      await attachJson("result", result);
      await attachText("elapsed_ms", String(elapsedMs));
    });

    expect("error" in result, "Cache hit should not error").toBe(false);

    const { research, source } = result as {
      research: Research;
      source: string;
      wasRefreshed: boolean;
    };

    // Should come from cache
    expect(source).toBe("cache");

    // Should be the same research
    expect(research.id).toBe(firstResearch!.id);

    // Cache hits should be fast — much less than a full research cycle
    // We use 30s as the threshold since a full research takes 60-120s+
    expect(elapsedMs, "Cache hit should resolve under 30s").toBeLessThan(30_000);
  }, 120_000);

  // ── Test 3: Force Refresh Bypasses Cache ──────────────────────────

  it("force refresh creates new research despite fresh cache", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Force Refresh Flow");

    expect(firstResearch, "Test 1 must have created research").toBeDefined();

    const result = await conductResearchDirect(
      {
        subject: "TypeScript generics best practices",
        forceRefresh: true,
        tenantId: process.env.RMS_TENANT_ID,
      },
      deps,
    );

    await allure.step("Force refresh result", async () => {
      await attachJson("result", result);
    });

    expect("error" in result, "Force refresh should not error").toBe(false);

    const { research, wasRefreshed } = result as {
      research: Research;
      source: string;
      wasRefreshed: boolean;
    };
    createdIds.push(research.id);

    // Should indicate it was a refresh
    expect(wasRefreshed).toBe(true);

    // Should have fresh content
    expect(research.summary.length).toBeGreaterThanOrEqual(200);
    expect(research.sourceUrls.length).toBeGreaterThanOrEqual(1);
  }, 600_000);

  // ── Test 4: Guardrail Blocks Forbidden Query ──────────────────────

  it("guardrail blocks forbidden research subjects", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Guardrail Block Flow");
    await allure.severity("critical");

    const forbiddenSubject = "how to hack a corporate network system";

    const startMs = Date.now();
    const result = await conductResearchDirect(
      { subject: forbiddenSubject, forceRefresh: true, tenantId: process.env.RMS_TENANT_ID },
      deps,
    );
    const elapsedMs = Date.now() - startMs;

    await allure.step("Guardrail block result", async () => {
      await attachJson("result", result);
      await attachText("elapsed_ms", String(elapsedMs));
    });

    // Should return an error (forceRefresh bypasses cache, ensuring guardrail runs)
    expect(
      "error" in result,
      `Guardrail should produce an error, got: ${JSON.stringify(result)}`,
    ).toBe(true);
    const errorMsg = String((result as { error: string }).error).toLowerCase();
    expect(
      errorMsg.includes("blocked") || errorMsg.includes("policy") || errorMsg.includes("forbidden"),
      `Error message should indicate policy block, got: "${errorMsg}"`,
    ).toBe(true);

    // Should not contain a research object
    expect((result as Record<string, unknown>).research).toBeUndefined();
  }, 60_000);

  // ── Test 5: Streaming Events ──────────────────────────────────────

  it("streaming emits expected event sequence", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Streaming Events");
    await allure.severity("critical");

    // Use a very distinct subject to avoid semantic cache hits from earlier tests
    const subject = "quantum computing error correction surface codes 2025";
    const events: RmsEvent[] = [];

    for await (const event of streamResearch({ subject, forceRefresh: true }, deps)) {
      events.push(event);
    }

    // Track for cleanup — research is only persisted on the persist path
    const completeEvent = events.find((e) => e.type === "PERSIST_COMPLETE");
    if (completeEvent?.data && typeof completeEvent.data === "object") {
      const output = completeEvent.data as Record<string, unknown>;
      const research = output["research"] as Record<string, unknown> | undefined;
      if (research?.id) {
        createdIds.push(research.id as string);
      }
    }

    await allure.step("Streaming events", async () => {
      await attachJson(
        "events",
        events.map((e) => ({ type: e.type, timestamp: e.timestamp })),
      );
    });

    const eventTypes = events.map((e) => e.type);

    // Core lifecycle events common to ALL paths (both persist and human-approval)
    const required: Array<RmsEvent["type"]> = [
      "FRESHNESS_CHECK_START",
      "FRESHNESS_CHECK_COMPLETE",
      "SEARCH_START",
      "SEARCH_COMPLETE",
      "SUMMARIZATION_START",
      "SUMMARIZATION_COMPLETE",
      "RESEARCH_COMPLETE",
    ];

    for (const eventType of required) {
      expect(eventTypes, `Missing event: ${eventType}`).toContain(eventType);
    }

    // After summarization, the workflow either:
    //  - Routes to persister (confidence ≥ 0.4) → PERSIST_START/PERSIST_COMPLETE
    //  - Routes to human_approval (confidence < 0.4) → HUMAN_APPROVAL_REQUIRED
    const tookPersistPath = eventTypes.includes("PERSIST_START");
    const tookApprovalPath = eventTypes.includes("HUMAN_APPROVAL_REQUIRED");
    expect(
      tookPersistPath || tookApprovalPath,
      `Expected either persist path (PERSIST_START) or approval path (HUMAN_APPROVAL_REQUIRED), ` +
        `got: [${eventTypes.join(", ")}]`,
    ).toBe(true);

    if (tookPersistPath) {
      expect(eventTypes, "Persist path should include PERSIST_COMPLETE").toContain(
        "PERSIST_COMPLETE",
      );
    }

    // Events should have valid timestamps
    for (const event of events) {
      expect(event.timestamp).toBeDefined();
      expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
    }

    // RESEARCH_COMPLETE should be the last event
    expect(events[events.length - 1]!.type).toBe("RESEARCH_COMPLETE");

    // Start events should come before their corresponding complete events
    for (const prefix of ["FRESHNESS_CHECK", "SEARCH", "SUMMARIZATION", "PERSIST"]) {
      const startIdx = eventTypes.indexOf(`${prefix}_START` as RmsEvent["type"]);
      const endIdx = eventTypes.indexOf(`${prefix}_COMPLETE` as RmsEvent["type"]);
      if (startIdx !== -1 && endIdx !== -1) {
        expect(startIdx, `${prefix}_START should come before ${prefix}_COMPLETE`).toBeLessThan(
          endIdx,
        );
      }
    }
  }, 600_000);

  // ── Test 6: Multi-Tenancy Isolation ───────────────────────────────

  it("tenant isolation ensures queries don't leak across tenants", async () => {
    await allure.epic("RMS Workflow Integration");
    await allure.feature("Multi-Tenancy Isolation");
    await allure.severity("critical");

    // Helper: retry with alternative subjects if LLM confidence < 0.4 triggers
    // the human approval interrupt. Uses factual, well-documented topics that
    // consistently produce high-confidence summaries.
    async function conductWithRetry(
      tenantId: string,
      subjects: string[],
    ): Promise<{ research: Research; source: string; wasRefreshed: boolean }> {
      for (const subject of subjects) {
        const result = await conductResearchDirect({ subject, tenantId, forceRefresh: true }, deps);
        if (!("error" in result)) return result;
        // Interrupted by confidence gating — try next subject
        await allure.step(`Subject "${subject}" interrupted, retrying`, async () => {
          await attachJson("interrupt_result", result);
        });
      }
      throw new Error(
        `All subjects for ${tenantId} triggered human approval interrupt: [${subjects.join(", ")}]`,
      );
    }

    // Use well-documented, factual topics that reliably produce high confidence
    const resultA = await conductWithRetry("tenant-int-a", [
      "HTTP status codes 4xx and 5xx meaning",
      "JavaScript array methods map filter reduce",
      "TCP three way handshake explained",
    ]);

    await allure.step("Tenant A result", async () => {
      await attachJson("result_a", resultA);
    });

    const researchA = resultA.research;
    expect(researchA, "Tenant A research should be defined").toBeDefined();
    createdIds.push(researchA.id);

    // Create research for tenant-b with a distinctly different domain
    const resultB = await conductWithRetry("tenant-int-b", [
      "SQL JOIN types inner outer cross",
      "CSS flexbox vs grid layout differences",
      "Git rebase vs merge workflow",
    ]);

    await allure.step("Tenant B result", async () => {
      await attachJson("result_b", resultB);
    });

    const researchB = resultB.research;
    expect(researchB, "Tenant B research should be defined").toBeDefined();
    createdIds.push(researchB.id);

    await allure.step("Created tenant research", async () => {
      await attachJson("tenant_a", { id: researchA.id, subject: researchA.subject });
      await attachJson("tenant_b", { id: researchB.id, subject: researchB.subject });
    });

    // Search with tenant-a filter — should NOT return tenant-b's research
    const searchA = await repo.search(researchB.subject, {
      k: 10,
      filter: { tenantId: "tenant-int-a" },
    });
    const searchAIds = searchA.map((r) => r.research.id);
    expect(searchAIds, "Tenant A search should not contain tenant B's research").not.toContain(
      researchB.id,
    );

    // Search with tenant-b filter — should NOT return tenant-a's research
    const searchB = await repo.search(researchA.subject, {
      k: 10,
      filter: { tenantId: "tenant-int-b" },
    });
    const searchBIds = searchB.map((r) => r.research.id);
    expect(searchBIds, "Tenant B search should not contain tenant A's research").not.toContain(
      researchA.id,
    );

    // List with tenant-a filter
    const listA = await repo.list({ tenantId: "tenant-int-a", limit: 100 });
    const listAIds = listA.items.map((r) => r.id);
    expect(listAIds, "Tenant A list should not contain tenant B's research").not.toContain(
      researchB.id,
    );

    // List with tenant-b filter
    const listB = await repo.list({ tenantId: "tenant-int-b", limit: 100 });
    const listBIds = listB.items.map((r) => r.id);
    expect(listBIds, "Tenant B list should not contain tenant A's research").not.toContain(
      researchA.id,
    );

    await allure.step("Isolation verified", async () => {
      await attachJson("search_a_ids", searchAIds);
      await attachJson("search_b_ids", searchBIds);
      await attachJson("list_a_ids", listAIds);
      await attachJson("list_b_ids", listBIds);
    });
  }, 900_000);
});
