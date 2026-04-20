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

// Shared helpers used by every per-tool contract suite below.
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

describe("cueapi_pause_cue / cueapi_resume_cue — HTTP contract", () => {
  // CueAPI does not have /pause or /resume endpoints. Status is mutated
  // via PATCH /v1/cues/{id}. These tests pin the handler's HTTP behavior
  // so a regression to the non-existent POST /pause / POST /resume routes
  // (which would 404 at runtime) is caught at CI time, not in production.

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

describe("cueapi_create_cue — HTTP contract", () => {
  it("POSTs /v1/cues with name and cron", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "daily-sync",
      cron: "0 9 * * *",
      callback_url: "https://example.com/hook",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/cues");
    expect(calls[0].body).toEqual({
      name: "daily-sync",
      cron: "0 9 * * *",
      callback_url: "https://example.com/hook",
    });
  });

  it("includes one-time 'at' when provided instead of cron", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "reminder",
      at: "2026-05-01T14:00:00Z",
      callback_url: "https://example.com/notify",
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.at).toBe("2026-05-01T14:00:00Z");
    expect(body.cron).toBeUndefined();
  });

  it("sets worker=true for worker-transport cues", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "agent-task",
      cron: "0 * * * *",
      worker: true,
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.worker).toBe(true);
    expect(body.callback_url).toBeUndefined();
  });

  it("omits optional fields left undefined", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "minimal",
      cron: "0 9 * * *",
      callback_url: "https://example.com",
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body).not.toHaveProperty("timezone");
    expect(body).not.toHaveProperty("payload");
    expect(body).not.toHaveProperty("description");
    expect(body).not.toHaveProperty("worker");
  });

  it("forwards payload, timezone, and description when set", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "t",
      cron: "0 9 * * *",
      callback_url: "https://example.com",
      timezone: "America/Los_Angeles",
      payload: { task: "summarize" },
      description: "Morning briefing",
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.timezone).toBe("America/Los_Angeles");
    expect(body.payload).toEqual({ task: "summarize" });
    expect(body.description).toBe("Morning briefing");
  });
});

describe("cueapi_list_cues — HTTP contract", () => {
  it("GETs /v1/cues with no query when no filter", async () => {
    const tool = findTool("cueapi_list_cues");
    const { client, calls } = stubClient();
    await tool.handler(client, {});
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/cues");
    expect(calls[0].body).toBeNull();
  });

  it("forwards status filter as query param", async () => {
    const tool = findTool("cueapi_list_cues");
    const { client, calls } = stubClient();
    await tool.handler(client, { status: "active" });
    expect(calls[0].query).toEqual({ status: "active" });
  });
});

describe("cueapi_get_cue — HTTP contract", () => {
  it("GETs /v1/cues/{id}", async () => {
    const tool = findTool("cueapi_get_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123" });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123");
  });

  it("url-encodes the cue_id", async () => {
    const tool = findTool("cueapi_get_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "a b/c" });
    expect(calls[0].path).toBe("/v1/cues/a%20b%2Fc");
  });
});

describe("cueapi_delete_cue — HTTP contract", () => {
  it("DELETEs /v1/cues/{id}", async () => {
    const tool = findTool("cueapi_delete_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123" });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123");
    expect(calls[0].body).toBeUndefined();
  });

  it("url-encodes the cue_id", async () => {
    const tool = findTool("cueapi_delete_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue/slash" });
    expect(calls[0].path).toBe("/v1/cues/cue%2Fslash");
  });
});

describe("cueapi_list_executions — HTTP contract", () => {
  it("GETs /v1/executions with no query when no filter", async () => {
    const tool = findTool("cueapi_list_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, {});
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/executions");
    expect(calls[0].body).toBeNull();
  });

  it("forwards cue_id, status, limit, offset as query params", async () => {
    const tool = findTool("cueapi_list_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc",
      status: "success",
      limit: 50,
      offset: 10,
    });
    expect(calls[0].query).toEqual({
      cue_id: "cue_abc",
      status: "success",
      limit: 50,
      offset: 10,
    });
  });
});

describe("cueapi_report_outcome — HTTP contract", () => {
  it("POSTs /v1/executions/{id}/outcome with success flag", async () => {
    const tool = findTool("cueapi_report_outcome");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc", success: true });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/executions/exec_abc/outcome");
    expect(calls[0].body).toEqual({ success: true });
  });

  it("forwards evidence fields (external_id, result_url, summary)", async () => {
    const tool = findTool("cueapi_report_outcome");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      execution_id: "exec_abc",
      success: true,
      external_id: "lead-batch-7842",
      result_url: "https://example.com/7842",
      summary: "Generated 47 leads",
    });
    expect(calls[0].body).toEqual({
      success: true,
      external_id: "lead-batch-7842",
      result_url: "https://example.com/7842",
      summary: "Generated 47 leads",
    });
  });

  it("omits evidence fields that weren't provided", async () => {
    const tool = findTool("cueapi_report_outcome");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      execution_id: "exec_abc",
      success: false,
      summary: "boom",
    });
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toEqual({ success: false, summary: "boom" });
    expect(body).not.toHaveProperty("external_id");
    expect(body).not.toHaveProperty("result_url");
  });

  it("url-encodes the execution_id in the path", async () => {
    const tool = findTool("cueapi_report_outcome");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      execution_id: "exec/with/slash",
      success: true,
    });
    expect(calls[0].path).toBe("/v1/executions/exec%2Fwith%2Fslash/outcome");
  });
});
