# cueapi-mcp

Official [Model Context Protocol](https://modelcontextprotocol.io) server for [CueAPI](https://cueapi.ai), the open-source coordination layer for AI agent systems.

Give your MCP-enabled assistant (Claude Desktop, Cursor, Zed, or any other MCP host) the ability to schedule agent work, fetch execution history, and close the loop with evidence-backed outcome reports, all from inside a conversation.

## Why

Agents don't finish in one call. They coordinate across time, tools, environments, agents, and humans. Every handoff is a place where silent failure hides. CueAPI closes each handoff with structured evidence: an external ID, a result URL, or an artifact. This MCP server gives the agent direct access to that surface, so the agent can both schedule its own follow-up work and report outcomes with proof.

## Install

```bash
npm install -g @cueapi/mcp
# or use via npx (no install):
npx -y @cueapi/mcp
```

## Configure (Claude Desktop)

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "cueapi": {
      "command": "npx",
      "args": ["-y", "@cueapi/mcp"],
      "env": {
        "CUEAPI_API_KEY": "cue_sk_..."
      }
    }
  }
}
```

Generate your API key at [cueapi.ai](https://cueapi.ai). Self-hosting? Set `CUEAPI_BASE_URL` alongside `CUEAPI_API_KEY`.

## Configure (Cursor / Zed / other hosts)

Any MCP host that supports stdio servers can run this. Point the host at the `cueapi-mcp` binary and pass `CUEAPI_API_KEY` in the environment.

## Tools exposed

| Tool                    | What it does                                                  |
|-------------------------|---------------------------------------------------------------|
| `cueapi_create_cue`     | Create a recurring (cron) or one-time (`at`) cue              |
| `cueapi_list_cues`      | List cues, filter by status                                   |
| `cueapi_get_cue`        | Fetch details for a single cue                                |
| `cueapi_fire_cue`       | Fire an existing cue immediately, optional payload override   |
| `cueapi_pause_cue`      | Pause a cue so it stops firing                                |
| `cueapi_resume_cue`     | Resume a paused cue                                           |
| `cueapi_delete_cue`     | Delete a cue permanently                                      |
| `cueapi_list_executions`| List historical executions, filter by cue/status              |
| `cueapi_get_execution`  | Fetch a single execution by ID, with state + outcome          |
| `cueapi_list_claimable_executions` | List unclaimed worker executions, filter server-side by task/agent |
| `cueapi_claim_execution`| Atomically claim a specific execution for processing          |
| `cueapi_claim_next_execution` | Claim the next available execution (optional task filter) |
| `cueapi_execution_heartbeat` | Extend the claim lease on an in-flight execution         |
| `cueapi_report_outcome` | Report write-once outcome with evidence (external ID / URL)   |

## Example conversation

> **You:** Schedule a daily 9am job that posts a digest to my webhook.
>
> **Assistant (uses `cueapi_create_cue`):** Created cue `cue_abc123`, first fire tomorrow at 9:00 UTC.
>
> **You:** Show me the last five times it ran.
>
> **Assistant (uses `cueapi_list_executions`):** ...

## Development

```bash
npm install
npm test        # vitest smoke tests for the tool surface
npm run build   # compile TypeScript to dist/
npm run dev     # run the server locally with tsx
```

## Links

- **CueAPI homepage:** https://cueapi.ai
- **Docs:** https://docs.cueapi.ai
- **Core (open source):** https://github.com/cueapi/cueapi-core
- **Model Context Protocol:** https://modelcontextprotocol.io

## Changelog

- **0.4.0.** Add five execution-lifecycle tools — `cueapi_get_execution`, `cueapi_list_claimable_executions`, `cueapi_claim_execution`, `cueapi_claim_next_execution`, `cueapi_execution_heartbeat`. Closes the receive-claim-process-complete loop for MCP-host agents that want to consume worker-transport executions from in-session (e.g. Claude Desktop, Cursor, Zed). Highlights: `list_claimable_executions` filters server-side via `task` / `agent` query params (client-side filtering hits a known LIMIT-50 starvation bug); `claim_next_execution` accepts an optional `task_name` and internally fans out (filtered list → pick oldest → claim by ID) since the server doesn't yet support a task filter on the bare claim endpoint; `execution_heartbeat` sends `worker_id` via the `X-Worker-Id` request header (the server's transport for that field) and requires it in the schema so misconfigured callers fail at the wrapper instead of silently bypassing race protection. Internal: `CueAPIClient.request()` gains an optional `extraHeaders` parameter to support per-call custom headers.
- **0.3.0.** Add `cueapi_fire_cue` tool: fire an existing cue immediately with an optional `payload_override` (and `merge_strategy: 'merge' | 'replace'`, default `'merge'`). Wraps `POST /v1/cues/{id}/fire`. Lets agents trigger ad-hoc one-shot executions without creating throwaway cues, and lets per-fire dynamic data flow through to webhook dispatch + worker-claim responses without mutating the stored cue.
- **0.1.4.** Fix `cueapi_pause_cue` / `cueapi_resume_cue` to use `PATCH /v1/cues/{id}` with `{"status": "paused" | "active"}` (previously called non-existent `/pause` and `/resume` endpoints, returning a runtime 404). PR [#1](https://github.com/cueapi/cueapi-mcp/pull/1). This is the release that actually contains the fix; 0.1.3 was published prematurely with this note but without the merged code.
- **0.1.3.** Premature publish, superseded by 0.1.4. No functional changes from 0.1.2.
- **0.1.2.** Register with the Official MCP Registry.
- **0.1.0.** Initial release: 8 tools for create / list / get / pause / resume / delete cues, list executions, report outcome.

## License

MIT © Vector Apps Inc.
