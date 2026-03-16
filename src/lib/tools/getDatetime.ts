import { tool } from "@langchain/core/tools";
import { GetDateTimeInputSchema } from "../schemas/lifecycleSchemas.js";
import { wrapToolResponse } from "../helpers.js";

/**
 * Creates the `rms_get_datetime` tool.
 * Returns the current date, time, and timezone — useful for agents
 * that need to know "now" for freshness decisions.
 */
export function createGetDatetimeTool() {
  return tool(
    () => {
      const now = new Date();
      return wrapToolResponse({
        iso: now.toISOString(),
        unix: now.getTime(),
        date: now.toLocaleDateString("en-CA"), // YYYY-MM-DD
        time: now.toLocaleTimeString("en-GB", { hour12: false }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
      });
    },
    {
      name: "rms_get_datetime",
      description:
        "Get the current date, time, timezone, and day of the week. Returns ISO 8601 timestamp, Unix timestamp, and human-readable date/time values. Use this whenever you need to know the current time for freshness checks or time-sensitive decisions.",
      schema: GetDateTimeInputSchema,
    },
  );
}
