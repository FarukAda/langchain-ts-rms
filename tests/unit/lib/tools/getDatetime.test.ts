import { describe, it, expect } from "vitest";
import { createGetDatetimeTool } from "../../../../src/lib/tools/getDatetime.js";

describe("rms_get_datetime", () => {
  it("returns current datetime info", async () => {
    const tool = createGetDatetimeTool();
    const rawResult = await tool.invoke({});
    const result = JSON.parse(rawResult) as Record<string, unknown>;

    expect(result["version"]).toBe("1.0");
    expect(result["iso"]).toBeDefined();
    expect(result["unix"]).toBeTypeOf("number");
    expect(result["date"]).toBeTypeOf("string");
    expect(result["time"]).toBeTypeOf("string");
    expect(result["timezone"]).toBeTypeOf("string");
    expect(result["dayOfWeek"]).toBeTypeOf("string");
  });

  it("has correct tool name and description", () => {
    const tool = createGetDatetimeTool();
    expect(tool.name).toBe("rms_get_datetime");
    expect(tool.description).toContain("current date");
  });
});
