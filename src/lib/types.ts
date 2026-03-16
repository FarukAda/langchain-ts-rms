import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { StructuredToolInterface } from "@langchain/core/tools";

import type { IResearchRepository } from "../domain/ports.js";
import type { Research } from "../domain/contracts.js";

/**
 * Dependency container injected into every RMS tool factory.
 * Mirrors GMS's `GmsToolDeps` interface.
 */
export interface RmsToolDeps {
  researchRepository: IResearchRepository;
  embeddings?: EmbeddingsInterface | undefined;
  chatModel: BaseChatModel;
  freshnessDays?: number | undefined;
  toolName?: string | undefined;
  toolDescription?: string | undefined;
  /**
   * Optional checkpointer for LangGraph state persistence.
   * Required for HITL (human-in-the-loop) resume flows.
   *
   * For production, use `@langchain/langgraph-checkpoint-sqlite` or
   * `@langchain/langgraph-checkpoint-postgres`.
   * If omitted, defaults to in-memory `MemorySaver` (development only;
   * throws in `NODE_ENV=production`).
   */
  checkpointer?: BaseCheckpointSaver | undefined;

  // --- Execution hooks (mirrors GMS Feature 7) ---
  /** Fired when new research is successfully persisted. */
  onResearchComplete?: (research: Research) => void | Promise<void>;
  /** Fired when the workflow requires human approval. */
  onApprovalRequired?: (subject: string, confidence: number) => void | Promise<void>;
  /** Fired when a fresh cached research entry is returned (no new search). */
  onCacheHit?: (research: Research) => void | Promise<void>;
}

/**
 * Options for creating RMS tools from environment variables.
 */
export interface CreateRmsToolFromEnvOptions {
  bootstrap?: boolean;
  toolName?: string;
  toolDescription?: string;
  freshnessDays?: number;
}

/**
 * All tools returned by `createAllRmsToolsFromEnv`.
 */
export interface AllRmsTools {
  researchTool: StructuredToolInterface;
  lifecycleTools: StructuredToolInterface[];
}
