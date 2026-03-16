import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { loadEnv } from "../../config/env.js";
import { logInfo, logWarn } from "../observability/tracing.js";

/**
 * Configuration for the checkpointer factory.
 * All fields are optional — environment variables are used as defaults.
 */
export interface CheckpointerOptions {
  /**
   * Backend to use: `"memory"` or `"sqlite"`.
   * Falls back to `RMS_CHECKPOINTER` env var, then `"memory"`.
   */
  backend?: "memory" | "sqlite" | undefined;
  /**
   * SQLite connection string (file path).
   * Falls back to `RMS_CHECKPOINT_DB` env var, then `"rms_checkpoints.db"`.
   */
  sqliteConnectionString?: string | undefined;
}

/**
 * Creates a checkpointer based on configuration.
 *
 * - `"memory"` → in-process {@link MemorySaver} (development/testing only)
 * - `"sqlite"` → durable SQLite-backed saver via `@langchain/langgraph-checkpoint-sqlite`
 *
 * The SQLite backend is dynamically imported so the package is only required
 * when actually selected. This avoids adding a hard dependency for users who
 * don't need HITL persistence.
 *
 * @example
 * ```ts
 * // Uses env vars (RMS_CHECKPOINTER, RMS_CHECKPOINT_DB)
 * const checkpointer = await createCheckpointer();
 *
 * // Explicit configuration
 * const checkpointer = await createCheckpointer({ backend: "sqlite", sqliteConnectionString: "./data/rms.db" });
 * ```
 */
export async function createCheckpointer(opts?: CheckpointerOptions): Promise<BaseCheckpointSaver> {
  const env = loadEnv();
  const backend = opts?.backend ?? env.RMS_CHECKPOINTER;

  if (backend === "sqlite") {
    const connString = opts?.sqliteConnectionString ?? env.RMS_CHECKPOINT_DB;
    logInfo("Creating SQLite checkpointer", { connectionString: connString });

    try {
      // Dynamic import — @langchain/langgraph-checkpoint-sqlite is an optional peer dependency.
      // Variable indirection prevents TS from resolving the module at compile time.
      const pkgName = "@langchain/langgraph-checkpoint-sqlite";
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const mod: Record<string, unknown> = await import(pkgName);
      const SqliteSaver = mod["SqliteSaver"] as
        | { fromConnString: (connString: string) => BaseCheckpointSaver }
        | undefined;
      if (!SqliteSaver) {
        throw new Error("SqliteSaver not found in @langchain/langgraph-checkpoint-sqlite");
      }
      return SqliteSaver.fromConnString(connString);
    } catch (err) {
      const msg =
        `Failed to create SQLite checkpointer: ${err instanceof Error ? err.message : String(err)}\n` +
        "Install the package: npm install @langchain/langgraph-checkpoint-sqlite";
      throw new Error(msg, { cause: err });
    }
  }

  logInfo("Creating in-memory checkpointer (MemorySaver)", { backend });
  if (process.env["NODE_ENV"] === "production") {
    logWarn(
      "MemorySaver is not suitable for production. " +
        "Set RMS_CHECKPOINTER=sqlite or inject a durable checkpointer via deps.checkpointer.",
    );
  }
  return new MemorySaver();
}
