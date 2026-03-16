import type { StructuredToolInterface } from "@langchain/core/tools";
import type { RmsToolDeps, CreateRmsToolFromEnvOptions, AllRmsTools } from "./types.js";
import { createResearchTool } from "./tools/research.js";
import { createGetResearchTool } from "./tools/getResearch.js";
import { createListResearchTool } from "./tools/listResearch.js";
import { createSearchResearchTool } from "./tools/searchResearch.js";
import { createDeleteResearchTool } from "./tools/deleteResearch.js";
import { createGetDatetimeTool } from "./tools/getDatetime.js";
import { createRefreshResearchTool } from "./tools/refreshResearch.js";
import { createEmbeddingProvider } from "../infra/embeddings/embeddingProvider.js";
import { createChatModelProvider } from "../infra/chat/chatModelProvider.js";

import { ResearchRepository } from "../infra/vector/researchRepository.js";
import { createQdrantClient } from "../infra/vector/qdrantClient.js";
import { createCheckpointer } from "../infra/checkpoint/checkpointerFactory.js";
import { loadEnv } from "../config/env.js";

// ── Re-exports for convenience ──

export {
  createResearchTool,
  createGetResearchTool,
  createListResearchTool,
  createSearchResearchTool,
  createDeleteResearchTool,
  createGetDatetimeTool,
  createRefreshResearchTool,
};

// ── Composite factories ──

/**
 * Creates all RMS lifecycle tools (get, list, search, delete, refresh, datetime).
 * Does NOT include the main research tool.
 */
export function createRmsLifecycleTools(deps: RmsToolDeps): StructuredToolInterface[] {
  return [
    createGetResearchTool(deps),
    createListResearchTool(deps),
    createSearchResearchTool(deps),
    createDeleteResearchTool(deps),
    createRefreshResearchTool(deps),
    createGetDatetimeTool(),
  ];
}

/**
 * Internal: builds RmsToolDeps from environment variables.
 * Creates a single shared Qdrant client and passes it to the repository.
 */
async function buildEnvDeps(options?: CreateRmsToolFromEnvOptions): Promise<RmsToolDeps> {
  const env = loadEnv();
  const embeddings = createEmbeddingProvider();
  const chatModel = createChatModelProvider();
  const client = createQdrantClient();
  const checkpointer = await createCheckpointer();

  const researchRepository = new ResearchRepository({ embeddings, client });

  const deps: RmsToolDeps = {
    researchRepository,
    embeddings,
    chatModel,
    checkpointer,
    freshnessDays: options?.freshnessDays ?? env.RMS_FRESHNESS_DAYS,
  };
  if (options?.toolName) deps.toolName = options.toolName;
  if (options?.toolDescription) deps.toolDescription = options.toolDescription;
  return deps;
}

/**
 * Creates the main `rms_research` tool from environment variables.
 */
export async function createRmsToolFromEnv(
  options?: CreateRmsToolFromEnvOptions,
): Promise<StructuredToolInterface> {
  const deps = await buildEnvDeps(options);
  return createResearchTool(deps);
}

/**
 * Creates all lifecycle tools from environment variables.
 */
export async function createRmsLifecycleToolsFromEnv(
  options?: CreateRmsToolFromEnvOptions,
): Promise<StructuredToolInterface[]> {
  const deps = await buildEnvDeps(options);
  return createRmsLifecycleTools(deps);
}

/**
 * Creates ALL RMS tools (research + lifecycle) from environment variables.
 */
export async function createAllRmsToolsFromEnv(
  options?: CreateRmsToolFromEnvOptions,
): Promise<AllRmsTools> {
  const deps = await buildEnvDeps(options);
  return {
    researchTool: createResearchTool(deps),
    lifecycleTools: createRmsLifecycleTools(deps),
  };
}
