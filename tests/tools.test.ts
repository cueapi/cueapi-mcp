import { describe, it, expect } from "vitest";
import { tools } from "../src/tools.js";

describe("cueapi-mcp tool surface", () => {
  it("exposes at least 8 tools", () => {
    expect(tools.length).toBeGreaterThanOrEqual(8);
  });

  it("every tool has a stable name in cueapi_* form", () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^cueapi_[a-z_]+$/);
    }
  });

  it("every tool has a non-empty description", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("every tool has a Zod object schema", () => {
    for (const t of tools) {
      expect(typeof t.schema.parse).toBe("function");
    }
  });

  it("tool names are unique", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("exposes the core create/list/get/delete + outcome surface", () => {
    const names = tools.map((t) => t.name);
    for (const required of [
      "cueapi_create_cue",
      "cueapi_list_cues",
      "cueapi_get_cue",
      "cueapi_delete_cue",
      "cueapi_list_executions",
      "cueapi_report_outcome",
    ]) {
      expect(names).toContain(required);
    }
  });
});
