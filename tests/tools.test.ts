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
      "cueapi_update_cue",
      "cueapi_delete_cue",
      "cueapi_list_executions",
      "cueapi_get_execution",
      "cueapi_list_claimable_executions",
      "cueapi_claim_execution",
      "cueapi_claim_next_execution",
      "cueapi_execution_heartbeat",
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

  it("does not send a request body or query (single-row endpoint)", async () => {
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

describe("cueapi_list_claimable_executions — HTTP contract", () => {
  // Filtering MUST be server-side (passed as query params) — NOT client-side.
  // Client-side filter after fetch hits the LIMIT 50 starvation bug fixed
  // in the 2026-04-25 prod incident (see app/routers/executions.py:122-131).
  // These tests pin the contract.

  function findTool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function stubClient(response: unknown = { executions: [] }) {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];
    const client = {
      request: vi.fn(async (method: string, path: string, body?: unknown, query?: unknown) => {
        calls.push({ method, path, body, query });
        return response;
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses GET /v1/executions/claimable with no query when no filters provided", async () => {
    const tool = findTool("cueapi_list_claimable_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/executions/claimable");
    expect(calls[0].query).toEqual({});
  });

  it("passes task_name as query param `task` (server-side SQL filter)", async () => {
    const tool = findTool("cueapi_list_claimable_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, { task_name: "cowork-workspace" });
    expect(calls[0].query).toEqual({ task: "cowork-workspace" });
  });

  it("passes agent as query param `agent`", async () => {
    const tool = findTool("cueapi_list_claimable_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, { agent: "writer-bot" });
    expect(calls[0].query).toEqual({ agent: "writer-bot" });
  });

  it("passes both task_name + agent when both provided", async () => {
    const tool = findTool("cueapi_list_claimable_executions");
    const { client, calls } = stubClient();
    await tool.handler(client, { task_name: "cowork-workspace", agent: "writer-bot" });
    expect(calls[0].query).toEqual({ task: "cowork-workspace", agent: "writer-bot" });
  });
});

describe("cueapi_claim_execution — HTTP contract", () => {
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
        return { claimed: true, execution_id: "exec_abc123", lease_seconds: 900 };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses POST /v1/executions/{id}/claim with worker_id in body", async () => {
    const tool = findTool("cueapi_claim_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc123", worker_id: "cowork-workspace" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/executions/exec_abc123/claim");
    expect(calls[0].body).toEqual({ worker_id: "cowork-workspace" });
  });

  it("url-encodes the execution_id in the path", async () => {
    const tool = findTool("cueapi_claim_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec/with/slashes", worker_id: "w" });
    expect(calls[0].path).toBe("/v1/executions/exec%2Fwith%2Fslashes/claim");
  });
});

describe("cueapi_claim_next_execution — HTTP contract", () => {
  // Without task_name → single POST /v1/executions/claim.
  // With task_name → fan-out: list_claimable filtered → pick oldest → claim by ID.
  // These tests pin both branches.

  function findTool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function stubClient(responses: Array<unknown> = []) {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: unknown }> = [];
    let i = 0;
    const client = {
      request: vi.fn(async (method: string, path: string, body?: unknown, query?: unknown) => {
        calls.push({ method, path, body, query });
        const resp = responses[i] ?? { claimed: true, execution_id: "exec_default", lease_seconds: 900 };
        i++;
        return resp;
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("without task_name → single POST /v1/executions/claim", async () => {
    const tool = findTool("cueapi_claim_next_execution");
    const { client, calls } = stubClient();
    await tool.handler(client, { worker_id: "cowork-workspace" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/executions/claim");
    expect(calls[0].body).toEqual({ worker_id: "cowork-workspace" });
  });

  it("with task_name → list_claimable(task) then claim_execution(first.id)", async () => {
    const tool = findTool("cueapi_claim_next_execution");
    const { client, calls } = stubClient([
      { executions: [{ execution_id: "exec_first" }, { execution_id: "exec_second" }] },
      { claimed: true, execution_id: "exec_first", lease_seconds: 900 },
    ]);
    await tool.handler(client, { worker_id: "cowork-workspace", task_name: "cowork-workspace" });

    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/v1/executions/claimable");
    expect(calls[0].query).toEqual({ task: "cowork-workspace" });

    expect(calls[1].method).toBe("POST");
    expect(calls[1].path).toBe("/v1/executions/exec_first/claim");
    expect(calls[1].body).toEqual({ worker_id: "cowork-workspace" });
  });

  it("with task_name + empty list → returns no_executions_for_task without claiming", async () => {
    const tool = findTool("cueapi_claim_next_execution");
    const { client, calls } = stubClient([{ executions: [] }]);
    const result = await tool.handler(client, { worker_id: "w", task_name: "no-such-task" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(result).toEqual({
      claimed: false,
      reason: "no_executions_for_task",
      task_name: "no-such-task",
    });
  });
});

describe("cueapi_execution_heartbeat — HTTP contract", () => {
  // Heartbeat sends worker_id via the X-Worker-Id REQUEST HEADER (not body).
  // The MCP wrapper requires worker_id in the schema (server permits omission
  // but bypasses race protection); these tests pin the header transport.

  function findTool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function stubClient() {
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      query?: unknown;
      apiKey?: unknown;
      extraHeaders?: unknown;
    }> = [];
    const client = {
      request: vi.fn(async (
        method: string,
        path: string,
        body?: unknown,
        query?: unknown,
        apiKey?: unknown,
        extraHeaders?: unknown
      ) => {
        calls.push({ method, path, body, query, apiKey, extraHeaders });
        return {
          execution_id: "exec_abc123",
          lease_extended_until: "2026-05-01T18:00:00Z",
          acknowledged: true,
        };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses POST /v1/executions/{id}/heartbeat with X-Worker-Id header (not body)", async () => {
    const tool = findTool("cueapi_execution_heartbeat");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc123", worker_id: "cowork-workspace" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/executions/exec_abc123/heartbeat");
    expect(calls[0].body).toBeNull();
    expect(calls[0].extraHeaders).toEqual({ "X-Worker-Id": "cowork-workspace" });
  });

  it("does NOT send worker_id in the request body (server reads it from header)", async () => {
    const tool = findTool("cueapi_execution_heartbeat");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec_abc123", worker_id: "w" });

    // Critical: if a future refactor accidentally sends worker_id in body
    // instead of header, the server will silently bypass the race protection
    // check (it only enforces match when the header is present).
    expect(calls[0].body).toBeNull();
  });

  it("url-encodes the execution_id in the path", async () => {
    const tool = findTool("cueapi_execution_heartbeat");
    const { client, calls } = stubClient();
    await tool.handler(client, { execution_id: "exec/with/slashes", worker_id: "w" });
    expect(calls[0].path).toBe("/v1/executions/exec%2Fwith%2Fslashes/heartbeat");
  });
});

describe("cueapi_update_cue — HTTP contract", () => {
  // PATCH /v1/cues/{id} with sparse body. cron and at are mutually exclusive
  // (one-time vs recurring). callback_url maps to body.callback.url. These
  // tests pin the body shape so a regression to the wrong path/method or a
  // mis-shaped schedule update is caught at CI.

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
        return { id: "cue_test", status: "active" };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses PATCH /v1/cues/{id}", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123", name: "renamed" });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].path).toBe("/v1/cues/cue_abc123");
  });

  it("sends only the fields explicitly passed (sparse update)", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123", name: "x" });
    expect(calls[0].body).toEqual({ name: "x" });
  });

  it("maps callback_url to body.callback.url (server contract)", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      callback_url: "https://example.com/hook",
    });
    expect(calls[0].body).toEqual({ callback: { url: "https://example.com/hook" } });
  });

  it("cron triggers schedule.type='recurring'", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123", cron: "0 9 * * *" });
    expect(calls[0].body).toEqual({
      schedule: { type: "recurring", cron: "0 9 * * *" },
    });
  });

  it("at triggers schedule.type='once'", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue_abc123", at: "2030-01-01T00:00:00Z" });
    expect(calls[0].body).toEqual({
      schedule: { type: "once", at: "2030-01-01T00:00:00Z" },
    });
  });

  it("cron + timezone bundles timezone into the schedule object", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
    expect(calls[0].body).toEqual({
      schedule: {
        type: "recurring",
        cron: "0 9 * * *",
        timezone: "America/Los_Angeles",
      },
    });
  });

  it("payload field passes through as body.payload", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    const payload = { task: "x", target: "y" };
    await tool.handler(client, { cue_id: "cue_abc123", payload });
    expect(calls[0].body).toEqual({ payload });
  });

  it("url-encodes the cue_id in the path", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { cue_id: "cue/with/slashes", name: "x" });
    expect(calls[0].path).toBe("/v1/cues/cue%2Fwith%2Fslashes");
  });

  // Per cueapi PR #590 — server-side payload_override enforcement.
  it("passes require_payload_override through unchanged (true)", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      require_payload_override: true,
    });
    expect(calls[0].body).toEqual({ require_payload_override: true });
  });

  it("passes require_payload_override=false explicitly (clear opt-in)", async () => {
    // Sparse-update semantics: when the caller explicitly passes false,
    // the body must contain the false value, not omit it. Pin against a
    // refactor that conflates "unset" and "false".
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      require_payload_override: false,
    });
    expect(calls[0].body).toEqual({ require_payload_override: false });
  });

  it("passes required_payload_keys through unchanged", async () => {
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      required_payload_keys: ["task", "token", "message"],
    });
    expect(calls[0].body).toEqual({
      required_payload_keys: ["task", "token", "message"],
    });
  });

  it("passes required_payload_keys=[] explicitly (clear list)", async () => {
    // Server treats [] as "no required keys" (clear the list). Pin against
    // a refactor that treats empty array as "unset" and drops the field.
    const tool = findTool("cueapi_update_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      cue_id: "cue_abc123",
      required_payload_keys: [],
    });
    expect(calls[0].body).toEqual({ required_payload_keys: [] });
  });
});

describe("cueapi_create_cue — HTTP contract", () => {
  // POST /v1/cues. Sparse body — only fields the caller explicitly set are
  // sent. Pinned so a future refactor doesn't accidentally start sending
  // client-side defaults that conflict with the server's defaults.

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
        return { id: "cue_test", status: "active" };
      }),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("uses POST /v1/cues with name only (worker omitted, no schedule)", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { name: "test-cue" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/cues");
    expect(calls[0].body).toEqual({ name: "test-cue" });
  });

  // Per cueapi PR #590 — server-side payload_override enforcement.
  it("passes require_payload_override + required_payload_keys through to body", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "coord-cue",
      worker: true,
      require_payload_override: true,
      required_payload_keys: ["task", "token"],
    });
    expect(calls[0].body).toEqual({
      name: "coord-cue",
      worker: true,
      require_payload_override: true,
      required_payload_keys: ["task", "token"],
    });
  });

  it("passes require_payload_override=false explicitly", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      name: "permissive-cue",
      require_payload_override: false,
    });
    expect(calls[0].body).toEqual({
      name: "permissive-cue",
      require_payload_override: false,
    });
  });

  it("omits both new PR #590 fields when caller doesn't pass them — server applies its own defaults", async () => {
    const tool = findTool("cueapi_create_cue");
    const { client, calls } = stubClient();
    await tool.handler(client, { name: "default-cue" });
    expect(calls[0].body).not.toHaveProperty("require_payload_override");
    expect(calls[0].body).not.toHaveProperty("required_payload_keys");
  });
});

describe("cueapi_send_message — HTTP contract (PR #619 BCC-light)", () => {
  // POST /v1/messages with sender via X-Cueapi-From-Agent HEADER (not body).
  // §17 BCC-light: the optional `notify: [agent_ref, ...]` field emits a
  // stripped notification copy to each listed agent alongside the main
  // delivery. These tests pin the body shape, header placement, and notify
  // semantics so a refactor putting `from` in the body or dropping the
  // header would break the test loudly. Mirrors cueapi-cli #29's pinning.

  function findTool(name: string) {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  }

  function stubClient() {
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      query?: unknown;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
    }> = [];
    const client = {
      request: vi.fn(
        async (
          method: string,
          path: string,
          body?: unknown,
          query?: unknown,
          apiKey?: string,
          extraHeaders?: Record<string, string>
        ) => {
          calls.push({ method, path, body, query, apiKey, extraHeaders });
          return {
            id: "msg_test",
            thread_id: "msg_test",
            status: "delivered",
            bcc_emitted: [],
          };
        }
      ),
    } as unknown as CueAPIClient;
    return { client, calls };
  }

  it("sends to POST /v1/messages with required fields in body", async () => {
    const tool = findTool("cueapi_send_message");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "Hello",
      body: "Test message",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/v1/messages");
    expect(calls[0].body).toEqual({
      to: "agt_bob",
      subject: "Hello",
      body: "Test message",
    });
  });

  it("sends `from` via X-Cueapi-From-Agent HEADER, NOT in the body", async () => {
    // Server contract per app/routers/messages.py reads sender from
    // Header(default=None, alias='X-Cueapi-From-Agent'). Pinned here
    // so a refactor putting `from` in the body would break loudly
    // at unit-test time instead of silently at integration-test time.
    const tool = findTool("cueapi_send_message");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "Hello",
      body: "Test",
    });

    expect(calls[0].extraHeaders).toEqual({
      "X-Cueapi-From-Agent": "agt_alice",
    });
    expect(calls[0].body).not.toHaveProperty("from");
  });

  // PR #619 — §17 BCC-light coverage. Each test below pins one of the
  // notify-field semantics rows from the PR description.
  it("notify=[a,b,c] passes through to body verbatim", async () => {
    const tool = findTool("cueapi_send_message");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "Spec review",
      body: "...",
      notify: ["agt_pm@mike", "agt_qa@mike"],
    });
    expect(calls[0].body).toMatchObject({
      to: "agt_bob",
      subject: "Spec review",
      body: "...",
      notify: ["agt_pm@mike", "agt_qa@mike"],
    });
  });

  it("notify=[] is omitted (server treats no field === empty list)", async () => {
    // The handler intentionally only includes `notify` when the array is
    // non-empty. Omitting matches the server's "no field" semantics
    // (no notification sent) — and avoids round-tripping an empty array
    // that future server code might mis-interpret.
    const tool = findTool("cueapi_send_message");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "x",
      body: "y",
      notify: [],
    });
    expect(calls[0].body).not.toHaveProperty("notify");
  });

  it("notify with 11+ entries — schema rejects client-side (Zod max 10)", async () => {
    // Server caps at 10 entries (HTTP 422 schema-level reject). This MCP
    // tool's Zod schema mirrors the cap so the failure surfaces at the
    // MCP host (caller) before any HTTP round-trip — clean error UX.
    const tool = findTool("cueapi_send_message");
    expect(() =>
      tool.schema.parse({
        to: "agt_bob",
        from: "agt_alice",
        subject: "x",
        body: "y",
        notify: Array(11).fill("agt_x"),
      })
    ).toThrow();
  });

  it("idempotency_key goes via Idempotency-Key HEADER, not body", async () => {
    // Same server contract as `from` — header, not body.
    const tool = findTool("cueapi_send_message");
    const { client, calls } = stubClient();
    await tool.handler(client, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "x",
      body: "y",
      idempotency_key: "user-action-123",
    });

    expect(calls[0].extraHeaders).toEqual({
      "X-Cueapi-From-Agent": "agt_alice",
      "Idempotency-Key": "user-action-123",
    });
    expect(calls[0].body).not.toHaveProperty("idempotency_key");
  });

  it("expects_reply=true passes through; false omitted (omit-when-default)", async () => {
    // Same omit-when-default pattern cueapi-cli uses for boolean flags
    // that default to false (--include-deleted, --has-evidence,
    // --expects-reply). Pin the omit so a refactor that always sends
    // the field can't accidentally start round-tripping false.
    const tool = findTool("cueapi_send_message");
    const { client: c1, calls: calls1 } = stubClient();
    await tool.handler(c1, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "x",
      body: "y",
      expects_reply: true,
    });
    expect(calls1[0].body).toMatchObject({ expects_reply: true });

    const { client: c2, calls: calls2 } = stubClient();
    await tool.handler(c2, {
      to: "agt_bob",
      from: "agt_alice",
      subject: "x",
      body: "y",
      expects_reply: false,
    });
    expect(calls2[0].body).not.toHaveProperty("expects_reply");
  });

  it("priority outside 1-5 is rejected client-side via Zod", async () => {
    const tool = findTool("cueapi_send_message");
    expect(() =>
      tool.schema.parse({
        to: "agt_bob",
        from: "agt_alice",
        subject: "x",
        body: "y",
        priority: 0,
      })
    ).toThrow();
    expect(() =>
      tool.schema.parse({
        to: "agt_bob",
        from: "agt_alice",
        subject: "x",
        body: "y",
        priority: 6,
      })
    ).toThrow();
  });

  it("body cap is 32KB at the schema layer", async () => {
    const tool = findTool("cueapi_send_message");
    // 32KB + 1 char → reject
    expect(() =>
      tool.schema.parse({
        to: "agt_bob",
        from: "agt_alice",
        subject: "x",
        body: "x".repeat(32769),
      })
    ).toThrow();
    // exactly 32KB → accept
    const parsed = tool.schema.parse({
      to: "agt_bob",
      from: "agt_alice",
      subject: "x",
      body: "x".repeat(32768),
    });
    expect(parsed.body.length).toBe(32768);
  });
});
