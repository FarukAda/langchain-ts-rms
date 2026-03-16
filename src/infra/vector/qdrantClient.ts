import { QdrantClient } from "@qdrant/qdrant-js";
import { loadEnv } from "../../config/env.js";
import { logInfo } from "../observability/tracing.js";

export const RESEARCH_COLLECTION = "rms_research";

const PAYLOAD_INDEX_FIELDS = [
  { field_name: "metadata.research_id", field_schema: "keyword" as const },
  { field_name: "metadata.subject", field_schema: "keyword" as const },
  { field_name: "metadata.status", field_schema: "keyword" as const },
  { field_name: "metadata.tenant_id", field_schema: "keyword" as const },
  { field_name: "metadata.updated_at", field_schema: "keyword" as const },
  { field_name: "metadata.tags", field_schema: "keyword" as const },
];

export interface QdrantClientConfig {
  url: string;
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 10000 (10s). */
  timeout?: number;
}

export function createQdrantClient(config?: Partial<QdrantClientConfig>): QdrantClient {
  const env = loadEnv();
  const opts: { url: string; apiKey?: string; timeout?: number } = {
    url: config?.url ?? env.QDRANT_URL,
    timeout: config?.timeout ?? env.QDRANT_TIMEOUT_MS,
  };
  const apiKey = config?.apiKey ?? env.QDRANT_API_KEY;
  if (apiKey) opts.apiKey = apiKey;
  return new QdrantClient(opts);
}

/**
 * Ensures collections exist and creates payload indexes for filtered search.
 * Idempotent: safe to call on every startup.
 *
 * If an existing collection has different vector dimensions (e.g. after
 * switching embedding models), it is automatically deleted and recreated.
 */
export async function bootstrapQdrantCollections(
  client: QdrantClient,
  vectorSize: number,
): Promise<void> {
  const collections = await client.getCollections();
  const names = new Set(collections.collections.map((c) => c.name));

  for (const name of [RESEARCH_COLLECTION]) {
    // If collection exists, validate vector dimensions match
    if (names.has(name)) {
      const info = await client.getCollection(name);
      const existingSize =
        typeof info.config.params.vectors === "object" && "size" in info.config.params.vectors
          ? (info.config.params.vectors.size as number)
          : undefined;

      if (existingSize !== undefined && existingSize !== vectorSize) {
        logInfo(
          `Collection "${name}" has vector size ${String(existingSize)}, expected ${String(vectorSize)}. Recreating.`,
        );
        await client.deleteCollection(name);
        names.delete(name);
      }
    }

    if (!names.has(name)) {
      try {
        await client.createCollection(name, {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        });
      } catch (e) {
        // Handle TOCTOU race: another process may have created the collection
        // between our getCollections() check and this createCollection() call.
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("Conflict") && !msg.includes("already exists")) {
          throw e;
        }
      }
    }

    for (const { field_name, field_schema } of PAYLOAD_INDEX_FIELDS) {
      try {
        await client.createPayloadIndex(name, {
          field_name,
          field_schema: { type: field_schema },
          wait: true,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("already exists") && !msg.includes("AlreadyExists")) {
          throw e;
        }
      }
    }
  }
}
