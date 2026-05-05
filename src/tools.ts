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

const updateCueSchema = z.object({
  cue_id: z.string().describe("CueAPI cue ID to update"),
  name: z.string().min(1).optional().describe("New cue name"),
  cron: z
    .string()
    .optional()
    .describe("New cron expression (also changes schedule type to recurring)"),
  at: z
    .string()
    .optional()
    .describe("New ISO-8601 timestamp (also changes schedule type to one-time)"),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe("New callback URL"),
  timezone: z.string().optional().describe("New IANA timezone"),
  payload: z
    .record(z.unknown())
    .optional()
    .describe("New stored payload (the cue's default payload, applied on every fire unless overridden by payload_override)"),
  description: z.string().optional().describe("New description"),
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

const fireCueSchema = z.object({
  cue_id: z.string().describe("CueAPI cue ID to fire (e.g. 'cue_...')"),
  payload_override: z
    .record(z.unknown())
    .optional()
    .describe(
      "Override the cue's default payload for this fire only. Persisted on the resulting execution row, never on the cue itself."
    ),
  merge_strategy: z
    .enum(["merge", "replace"])
    .optional()
    .describe(
      "How payload_override combines with the cue's stored payload. 'merge' (default) = shallow-merge, override wins on key collisions. 'replace' = use override as the final payload, ignore cue.payload."
    ),
});

const claimableExecutionsSchema = z.object({
  task_name: z
    .string()
    .optional()
    .describe(
      "Filter by payload.task at the SQL layer (server-side). Required for single-purpose workers — without it, sibling tasks ahead of yours in the LIMIT 50 window will starve your handler."
    ),
  agent: z
    .string()
    .optional()
    .describe("Filter by payload.agent at the SQL layer (server-side)."),
});

const claimExecutionSchema = z.object({
  execution_id: z.string().describe("Execution UUID from cueapi_list_claimable_executions"),
  worker_id: z
    .string()
    .describe(
      "Stable identifier for this worker — caller-defined, NOT session/process-scoped. Recommended: a slug like 'cowork-workspace' or 'your-agent-name'. Same value must be used across the claim → heartbeat → outcome lifecycle so the server can enforce ownership on heartbeat + outcome calls."
    ),
});

const claimNextExecutionSchema = z.object({
  worker_id: z
    .string()
    .describe(
      "Stable caller-defined identifier (see cueapi_claim_execution for guidance)."
    ),
  task_name: z
    .string()
    .optional()
    .describe(
      "Optional task filter. The server's POST /v1/executions/claim does NOT support a task filter today, so when task_name is provided the tool internally fans out: list_claimable(task=X) → pick oldest → claim_execution(id, worker_id). Two API calls per claim attempt; tiny race window where another worker could grab the picked execution between list and claim, but the claim is atomic so worst case is 409 and the caller retries."
    ),
});

const executionHeartbeatSchema = z.object({
  execution_id: z.string().describe("Execution currently in 'delivering' state, claimed by worker_id."),
  worker_id: z
    .string()
    .describe(
      "Same worker_id used at claim time. Sent as the X-Worker-Id request header. Server returns 403 if it doesn't match the recorded claimed_by_worker. Required by this MCP wrapper (server permits omission, but omitting silently bypasses race protection)."
    ),
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

// Messaging primitive — Phase 12.1.5. Minimum-viable scope: send_message
// only, with the §17 BCC-light notify field (PR #619). Full messaging
// lifecycle (get/read/ack/inbox/sent) tracked separately in
// `endpoints_missing` for a follow-up port.
const sendMessageSchema = z.object({
  to: z
    .string()
    .describe(
      "Recipient agent address — opaque ID 'agt_xxx' or slug-form 'agent_slug@user_slug'. NOT a cue_id; the messaging primitive addresses agents directly, not their inbound cues."
    ),
  from: z
    .string()
    .describe(
      "Sender agent address (same opaque-or-slug format as `to`). Sent as the X-Cueapi-From-Agent request header (the server contract — sender is NOT in the body). Required by this MCP wrapper."
    ),
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe("Short subject line (max 200 chars)."),
  body: z
    .string()
    .min(1)
    .max(32768)
    .describe("Message body (max 32 KB; for longer content put it in a Dock workspace and link)."),
  priority: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Message priority 1-5 (server-side scaled by tenant plan; values outside 1-5 are 422'd by the server)."
    ),
  expects_reply: z
    .boolean()
    .optional()
    .describe("Hint to the recipient that a reply is expected (omit when false; same omit-when-default pattern as cueapi-cli)."),
  reply_to: z
    .string()
    .optional()
    .describe("Message ID this is a reply to. Server uses it to thread (sets thread_id from the original)."),
  notify: z
    .array(z.string())
    .max(10)
    .optional()
    .describe(
      "§17 BCC-light (PR #619): list of agent addresses to receive a stripped notification copy alongside the main delivery. Each gets a separate Message row with body=`<from> → <to>: <subject>`, priority=3, metadata.notification_for=<main_id>, sharing the main message's thread_id so bcc'd recipients can reply into the thread. Self-bcc (notify includes `to`) silently de-duped. Duplicates within list de-duped. Cap: 10 entries (11+ → 422). Notifications skip the monthly quota. Response includes `bcc_emitted: [msg_id, ...]` (only on create — empty on subsequent GETs and idempotency dedup-hits)."
    ),
  idempotency_key: z
    .string()
    .optional()
    .describe(
      "Server dedups same-key sends from the same sender; dedup-hit returns the original message_id and bcc_emitted=[] (no re-emit of notifications). Recommended for retry-safe sends."
    ),
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
    name: "cueapi_fire_cue",
    description:
      "Fire an existing cue immediately, optionally overriding its payload for this single invocation. Creates an execution that runs through the cue's normal delivery path, regardless of the cue's schedule. Use payload_override + merge_strategy to swap or merge per-fire dynamic data without mutating the stored cue.",
    schema: fireCueSchema,
    handler: async (client, args) => {
      const body: Record<string, unknown> = {};
      if (args.payload_override) body.payload_override = args.payload_override;
      if (args.merge_strategy) body.merge_strategy = args.merge_strategy;
      return client.request(
        "POST",
        `/v1/cues/${encodeURIComponent(args.cue_id)}/fire`,
        body
      );
    },
  },
  {
    name: "cueapi_update_cue",
    description:
      "Update an existing cue's mutable fields (name, schedule, callback URL, timezone, payload, description). Only provided fields are updated; omitted fields are unchanged. Wraps PATCH /v1/cues/{id}. For status changes (active/paused) use cueapi_pause_cue / cueapi_resume_cue.",
    schema: updateCueSchema,
    handler: async (client, args) => {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.description !== undefined) body.description = args.description;
      if (args.payload !== undefined) body.payload = args.payload;
      if (args.callback_url !== undefined) body.callback = { url: args.callback_url };
      // Schedule update: cron and at are mutually exclusive (one-time vs recurring).
      // Mirror the CLI's pattern (cueapi-cli/cueapi/cli.py update command).
      if (args.cron !== undefined || args.at !== undefined) {
        const schedule: Record<string, unknown> = {};
        if (args.cron !== undefined) {
          schedule.type = "recurring";
          schedule.cron = args.cron;
        } else if (args.at !== undefined) {
          schedule.type = "once";
          schedule.at = args.at;
        }
        if (args.timezone !== undefined) schedule.timezone = args.timezone;
        body.schedule = schedule;
      }
      return client.request(
        "PATCH",
        `/v1/cues/${encodeURIComponent(args.cue_id)}`,
        body
      );
    },
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
    name: "cueapi_get_execution",
    description:
      "Fetch a single execution by ID, including its current state, outcome (if reported), and any attached evidence. The natural follow-up to cueapi_fire_cue (which returns an execution_id) when an agent wants to confirm the fire landed and check delivery state, instead of paginating cueapi_list_executions.",
    schema: executionIdSchema,
    handler: async (client, args) =>
      client.request(
        "GET",
        `/v1/executions/${encodeURIComponent(args.execution_id)}`
      ),
  },
  {
    name: "cueapi_list_claimable_executions",
    description:
      "List unclaimed worker-transport executions ready for processing (status pending or retry_ready). Filters server-side by payload.task and/or payload.agent — pass task_name when your worker only handles one task type, otherwise sibling tasks in the LIMIT 50 window can starve you. Different from cueapi_list_executions, which is all-states historical across all transports.",
    schema: claimableExecutionsSchema,
    handler: async (client, args) => {
      const query: Record<string, string> = {};
      if (args.task_name) query.task = args.task_name;
      if (args.agent) query.agent = args.agent;
      return client.request("GET", "/v1/executions/claimable", null, query);
    },
  },
  {
    name: "cueapi_claim_execution",
    description:
      "Atomically claim a specific worker-transport execution for processing. Use BEFORE running a handler so no other worker races you. Conditional UPDATE WHERE status IN ('pending', 'retry_ready'); returns 409 if already claimed or not eligible. Response includes lease_seconds (default 900s = 15 min); send execution_heartbeat well before that to extend.",
    schema: claimExecutionSchema,
    handler: async (client, args) =>
      client.request(
        "POST",
        `/v1/executions/${encodeURIComponent(args.execution_id)}/claim`,
        { worker_id: args.worker_id }
      ),
  },
  {
    name: "cueapi_claim_next_execution",
    description:
      "Claim the next available worker-transport execution. Without task_name, the server picks the oldest pending across any of your worker cues — fine for single-handler workers. With task_name, the tool fans out (list_claimable filtered → pick oldest → claim by ID) so multi-handler workers don't accidentally grab work for the wrong task. Returns 409 if no executions are claimable. Response includes lease_seconds (default 900s).",
    schema: claimNextExecutionSchema,
    handler: async (client, args) => {
      if (args.task_name) {
        // Server's POST /v1/executions/claim doesn't accept a task filter
        // today — fan out: filtered claimable → pick oldest → claim by ID.
        // Tiny race window between list and claim is bounded by the atomic
        // claim returning 409 if another worker beat us. Caller retries.
        const list = await client.request<{
          executions: Array<{ execution_id: string }>;
        }>("GET", "/v1/executions/claimable", null, { task: args.task_name });
        if (!list.executions || list.executions.length === 0) {
          return {
            claimed: false,
            reason: "no_executions_for_task",
            task_name: args.task_name,
          };
        }
        const next = list.executions[0];
        return client.request(
          "POST",
          `/v1/executions/${encodeURIComponent(next.execution_id)}/claim`,
          { worker_id: args.worker_id }
        );
      }
      // No task filter — server picks oldest of any type owned by this user.
      return client.request(
        "POST",
        "/v1/executions/claim",
        { worker_id: args.worker_id }
      );
    },
  },
  {
    name: "cueapi_execution_heartbeat",
    description:
      "Extend the claim lease on an in-flight execution. Send well before the lease expires (default 900s = 15 min from claim or last heartbeat); ~5 min cadence is a safe baseline. Response includes lease_extended_until — schedule your next heartbeat against that. Server returns 403 if X-Worker-Id doesn't match the worker that claimed; 409 if the execution is no longer in 'delivering' state. Skip entirely if your handler reliably completes well within the lease.",
    schema: executionHeartbeatSchema,
    handler: async (client, args) =>
      client.request(
        "POST",
        `/v1/executions/${encodeURIComponent(args.execution_id)}/heartbeat`,
        null,
        undefined,
        undefined,
        { "X-Worker-Id": args.worker_id }
      ),
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
  {
    name: "cueapi_send_message",
    description:
      "Send a direct agent-to-agent message via the Phase 12.1.5 messaging primitive. Use the `notify` field for §17 BCC-light fan-out (PR #619): each agent in `notify` gets a stripped notification copy alongside the main delivery, threaded with the main message so they can reply into the conversation. Sender (`from`) goes via the X-Cueapi-From-Agent request header (server contract — NOT in body). Useful for agent-to-agent coordination where the cue/execution model is heavier than needed (no scheduling, no handler binding, no reply-cue indirection).",
    schema: sendMessageSchema,
    handler: async (client, args) => {
      const body: Record<string, unknown> = {
        to: args.to,
        subject: args.subject,
        body: args.body,
      };
      if (args.priority !== undefined) body.priority = args.priority;
      if (args.expects_reply) body.expects_reply = args.expects_reply;
      if (args.reply_to) body.reply_to = args.reply_to;
      if (args.notify && args.notify.length > 0) body.notify = args.notify;
      const extraHeaders: Record<string, string> = {
        "X-Cueapi-From-Agent": args.from,
      };
      if (args.idempotency_key) {
        extraHeaders["Idempotency-Key"] = args.idempotency_key;
      }
      return client.request(
        "POST",
        "/v1/messages",
        body,
        undefined,
        undefined,
        extraHeaders
      );
    },
  },
];
