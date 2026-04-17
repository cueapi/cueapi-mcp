import { describe, it, expect, vi } from "vitest";
import { tools } from "../src/tools.js";
import type { CueAPIClient } from "../src/client.js";

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

describe("cueapi_pause_cue / cueapi_resume_cue — HTTP contract", () => {
  // CueAPI does not have /pause or /resume endpoints. Status is mutated
  // via PATCH /v1/cues/{id}. These tests pin the handler's HTTP behavior
  // so a regression to the non-existent POST /pause / POST /resume routes
  // (which would 404 at runtime) is caught at CI time, not in production.

  function findTool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function stubClient() {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, path: string, body?: unknown, query?: unknown) => {
        calls.push({ method, path, body, query });
        return { id: "cue_test", status: "ok" };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("pause uses PATCH /v1/cues/{id} with {status: 'paused'}", async () => {
    const tool = findTool("cueapi_pause_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123");
    expect(calls[0].body).toEqual({ status: "paused" });
  });

  it("resume uses PATCH /v1/cues/{id} with {status: 'active'}", async () => {
    const tool = findTool("cueapi_resume_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123");
    expect(calls[0].body).toEqual({ status: "active" });
  });

  it("url-encodes the cue_id in the path", async () => {
    const tool = findTool("cueapi_pause_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue/with/slashes" });
    expect(calls[0].path).toBe("/v1/cues/cue%2Fwith%2Fslashes");
  });
});
