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
      "cueapi_fire_cue",
      "cueapi_delete_cue",
      "cueapi_list_executions",
      "cueapi_get_execution",
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

describe("cueapi_fire_cue — HTTP contract", () => {
  // CueAPI fire endpoint is POST /v1/cues/{id}/fire. Body may include
  // payload_override (overrides the cue's default payload for this fire only)
  // and merge_strategy ('replace' | 'merge'). These tests pin the handler's
  // HTTP behavior so a regression to the wrong path/method is caught at CI.

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
        return { execution_id: "exec_test", status: "queued" };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("fires with no payload_override → POST /v1/cues/{id}/fire with empty body", async () => {
    const tool = findTool("cueapi_fire_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123/fire");
    expect(calls[0].body).toEqual({});
  });

  it("passes payload_override + merge_strategy='replace' through to body", async () => {
    const tool = findTool("cueapi_fire_cue");
    const { client, calls } = stubClient();
    const payload = { task: "downstream-handler", scope: "single-row" };
    await tool.handler(client, {
      cue_id: "cue_abc123",
      payload_override: payload,
      merge_strategy: "replace",
    });

    expect(calls[0].body).toEqual({ payload_override: payload, merge_strategy: "replace" });
  });

  it("passes payload_override + merge_strategy='merge' through to body", async () => {
    // 'merge' is the API's default and the most common case (swap a few
    // fields, keep the rest from cue.payload). Pin it explicitly so a
    // future refactor can't silently drop the strategy field on the way
    // through.
    const tool = findTool("cueapi_fire_cue");
    const { client, calls } = stubClient();
    const payload = { run_id: "ad-hoc-2026-05-01" };
    await tool.handler(client, {
      cue_id: "cue_abc123",
      payload_override: payload,
      merge_strategy: "merge",
    });

    expect(calls[0].body).toEqual({ payload_override: payload, merge_strategy: "merge" });
  });

  it("omits merge_strategy when only payload_override is set — server applies its own default ('merge')", async () => {
    // The handler intentionally only includes fields that were explicitly
    // passed. When the caller omits merge_strategy, the API's Pydantic
    // default of 'merge' applies server-side. This test pins that
    // contract: don't accidentally start sending a client-side default
    // that would override the server's choice.
    const tool = findTool("cueapi_fire_cue");
    const { client, calls } = stubClient();
    const payload = { task: "x" };
    await tool.handler(client, {
      cue_id: "cue_abc123",
      payload_override: payload,
    });

    expect(calls[0].body).toEqual({ payload_override: payload });
    expect(calls[0].body).not.toHaveProperty("merge_strategy");
  });

  it("url-encodes the cue_id in the path", async () => {
    const tool = findTool("cueapi_fire_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue/with/slashes" });
    expect(calls[0].path).toBe("/v1/cues/cue%2Fwith%2Fslashes/fire");
  });
});

describe("cueapi_get_execution — HTTP contract", () => {
  // CueAPI single-execution endpoint is GET /v1/executions/{id}. These tests
  // pin the handler's HTTP behavior so a regression to the wrong path/method
  // (e.g. accidentally hitting /v1/executions with a query filter) is caught
  // at CI rather than runtime.

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
        return { id: "exec_test", status: "delivered", outcome: null };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses GET /v1/executions/{id}", async () => {
    const tool = findTool("cueapi_get_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/executions/exec_abc123");
  });

  it("does not send a request body (GET endpoint)", async () => {
    // Regression guard: if a future refactor reuses the list-executions
    // schema or accidentally pipes args through, the handler could end up
    // sending a body or query. This single-row endpoint takes neither.
    const tool = findTool("cueapi_get_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc123" });

    expect(calls[0].body).toBeUndefined();
    expect(calls[0].query).toBeUndefined();
  });

  it("url-encodes the execution_id in the path", async () => {
    const tool = findTool("cueapi_get_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec/with/slashes" });
    expect(calls[0].path).toBe("/v1/executions/exec%2Fwith%2Fslashes");
  });
});
