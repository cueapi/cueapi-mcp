/**
 * CueAPI MCP tool definitions.
 *
 * Each tool:
 *   - has a stable name exposed to the MCP host,
 *   - has a Zod schema for input validation,
 *   - has a handler that returns a JSON-serializable payload.
 *
 * Tools are small, orthogonal, and map cleanly to the CueAPI REST surface.
 */

import { z } from "zod";
import { CueAPIClient } from "./client.js";

export interface ToolDefinition<
  TShape extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;
  description: string;
  schema: z.ZodObject<TShape>;
  handler: (
    client: CueAPIClient,
    args: z.infer<z.ZodObject<TShape>>
  ) => Promise<unknown>;
}

// ---------- schemas ----------

const createCueSchema = z.object({
  name: z.string().min(1).describe("Human-readable cue name"),
  cron: z
    .string()
    .optional()
    .describe("Cron expression for a recurring cue (e.g. '0 9 * * *')"),
  at: z
    .string()
    .optional()
    .describe("ISO-8601 timestamp for a one-time cue"),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe("Webhook URL fired when the cue triggers (omit for worker mode)"),
  worker: z
    .boolean()
    .optional()
    .describe("If true, use worker transport — no callback URL needed"),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone, default 'UTC'"),
  payload: z
    .record(z.unknown())
    .optional()
    .describe("Arbitrary JSON payload delivered with the cue"),
  description: z.string().optional(),
});

const cueIdSchema = z.object({
  cue_id: z.string().describe("CueAPI cue ID (e.g. 'cue_...')"),
});

const listCuesSchema = z.object({
  status: z
    .enum(["active", "paused"])
    .optional()
    .describe("Filter by status"),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const executionIdSchema = z.object({
  execution_id: z.string().describe("CueAPI execution ID"),
});

const listExecutionsSchema = z.object({
  cue_id: z.string().optional().describe("Filter to a specific cue"),
  status: z.string().optional().describe("Filter by execution status"),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const reportOutcomeSchema = z.object({
  execution_id: z.string(),
  success: z.boolean(),
  external_id: z.string().optional().describe("ID from the downstream system"),
  result_url: z
    .string()
    .url()
    .optional()
    .describe("Public URL proving the work happened (tweet, PR, etc.)"),
  summary: z
    .string()
    .max(500)
    .optional()
    .describe("Short human summary of what the agent did"),
});

// ---------- tools ----------

export const tools: ToolDefinition[] = [
  {
    name: "cueapi_create_cue",
    description:
      "Create a new CueAPI cue — a scheduled job that fires a callback (or enqueues worker work) on a cron or one-time trigger.",
    schema: createCueSchema,
    handler: async (client, args) => {
      const body: Record<string, unknown> = { name: args.name };
      if (args.cron) body.cron = args.cron;
      if (args.at) body.at = args.at;
      if (args.callback_url) body.callback_url = args.callback_url;
      if (args.worker) body.worker = true;
      if (args.timezone) body.timezone = args.timezone;
      if (args.payload) body.payload = args.payload;
      if (args.description) body.description = args.description;
      return client.request("POST", "/v1/cues", body);
    },
  },
  {
    name: "cueapi_list_cues",
    description: "List cues on the authenticated account, optionally filtered by status.",
    schema: listCuesSchema,
    handler: async (client, args) =>
      client.request("GET", "/v1/cues", null, args),
  },
  {
    name: "cueapi_get_cue",
    description: "Fetch a single cue by ID, including current schedule and most recent execution.",
    schema: cueIdSchema,
    handler: async (client, args) =>
      client.request("GET", `/v1/cues/${encodeURIComponent(args.cue_id)}`),
  },
  {
    name: "cueapi_pause_cue",
    description: "Pause a cue. Paused cues do not fire until resumed.",
    schema: cueIdSchema,
    handler: async (client, args) =>
      // CueAPI does not expose a dedicated pause endpoint — status is
      // mutated via PATCH, matching the CLI's behavior in
      // cueapi-cli/cueapi/cli.py:290-294.
      client.request(
        "PATCH",
        `/v1/cues/${encodeURIComponent(args.cue_id)}`,
        { status: "paused" }
      ),
  },
  {
    name: "cueapi_resume_cue",
    description: "Resume a previously-paused cue.",
    schema: cueIdSchema,
    handler: async (client, args) =>
      // "active" is the default status from the Cue model enum
      // (cueapi-core/app/models/cue.py:35 CHECK IN ('active','paused',
      // 'completed','failed')) — same value the CLI uses at
      // cueapi-cli/cueapi/cli.py:313.
      client.request(
        "PATCH",
        `/v1/cues/${encodeURIComponent(args.cue_id)}`,
        { status: "active" }
      ),
  },
  {
    name: "cueapi_delete_cue",
    description: "Delete a cue permanently. Irreversible.",
    schema: cueIdSchema,
    handler: async (client, args) =>
      client.request(
        "DELETE",
        `/v1/cues/${encodeURIComponent(args.cue_id)}`
      ),
  },
  {
    name: "cueapi_list_executions",
    description:
      "List executions — the historical record of times a cue actually fired. Optionally filter by cue, status, or paginate.",
    schema: listExecutionsSchema,
    handler: async (client, args) =>
      client.request("GET", "/v1/executions", null, args),
  },
  {
    name: "cueapi_report_outcome",
    description:
      "Report the outcome of an execution. CueAPI's core accountability primitive: attach evidence (external_id, result_url, summary) that proves the work actually happened. Write-once — the outcome record is immutable.",
    schema: reportOutcomeSchema,
    handler: async (client, args) => {
      const body: Record<string, unknown> = { success: args.success };
      if (args.external_id) body.external_id = args.external_id;
      if (args.result_url) body.result_url = args.result_url;
      if (args.summary) body.summary = args.summary;
      return client.request(
        "POST",
        `/v1/executions/${encodeURIComponent(args.execution_id)}/outcome`,
        body
      );
    },
  },
];
