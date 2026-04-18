#!/usr/bin/env node
/**
 * CueAPI MCP server — dual-transport entry point.
 *
 * Routes to either the stdio or HTTP transport based on a CLI flag or
 * env var. Stdio is the default — matches 0.1.x behavior exactly so
 * existing Claude Desktop / Claude Code / Cursor / Zed configurations
 * keep working on upgrade with zero changes:
 *
 *   {
 *     "mcpServers": {
 *       "cueapi": {
 *         "command": "npx",
 *         "args": ["-y", "@cueapi/mcp"],
 *         "env": { "CUEAPI_API_KEY": "cue_sk_..." }
 *       }
 *     }
 *   }
 *
 * HTTP transport is new in 0.2.0. Used by remote MCP hosts like
 * Claude.ai Custom Connectors that can't spawn a local subprocess.
 * Configured by setting ``MCP_TRANSPORT=http`` or passing
 * ``--transport http`` and supplying the OAuth-related env vars
 * (see ``http-entry.ts`` for the full list).
 */

function parseTransport(): "stdio" | "http" {
  // CLI flag wins over env var.
  const argFlag = process.argv.indexOf("--transport");
  if (argFlag >= 0 && process.argv[argFlag + 1]) {
    const v = process.argv[argFlag + 1].toLowerCase();
    if (v === "http" || v === "stdio") return v;
  }
  const env = (process.env.MCP_TRANSPORT || "").toLowerCase();
  if (env === "http") return "http";
  return "stdio";
}

async function main() {
  const transport = parseTransport();
  if (transport === "http") {
    const { runHttp } = await import("./http-entry.js");
    await runHttp();
  } else {
    const { runStdio } = await import("./stdio-entry.js");
    await runStdio();
  }
}

main().catch((err) => {
  console.error("[cueapi-mcp] fatal:", err);
  process.exit(1);
});
