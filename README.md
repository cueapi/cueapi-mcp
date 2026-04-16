# cueapi-mcp

Official [Model Context Protocol](https://modelcontextprotocol.io) server for [CueAPI](https://cueapi.ai) — the open-source execution accountability primitive for AI agents.

Give your MCP-enabled assistant (Claude Desktop, Cursor, Zed, or any other MCP host) the ability to schedule agent work, fetch execution history, and close the loop with evidence-backed outcome reports — all from inside a conversation.

## Why

CueAPI makes silent agent failure impossible: every scheduled run has to come back with evidence of what actually happened — an external ID, a result URL, or an artifact — before the cycle closes. This MCP server exposes that primitive directly to the agent itself, so the agent can both schedule its own follow-up work and report outcomes with proof.

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
| `cueapi_pause_cue`      | Pause a cue so it stops firing                                |
| `cueapi_resume_cue`     | Resume a paused cue                                           |
| `cueapi_delete_cue`     | Delete a cue permanently                                      |
| `cueapi_list_executions`| List historical executions, filter by cue/status              |
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

- **0.1.3** — Fix `cueapi_pause_cue` / `cueapi_resume_cue` to use `PATCH /v1/cues/{id}` with `{"status": "paused" | "active"}` (previously called non-existent `/pause` and `/resume` endpoints → runtime 404).
- **0.1.2** — Register with the Official MCP Registry.
- **0.1.0** — Initial release: 8 tools for create / list / get / pause / resume / delete cues, list executions, report outcome.

## License

MIT © Vector Apps Inc.
