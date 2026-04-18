/**
 * Stdio entry point — the original cueapi-mcp behavior, preserved
 * exactly as of 0.1.4.
 *
 * Used when ``cueapi-mcp`` is spawned as a subprocess by an MCP host
 * (Claude Desktop, Claude Code, Cursor, Zed). The host and the server
 * exchange MCP protocol messages over stdin/stdout. ``stderr`` is the
 * diagnostic channel — never log to stdout.
 *
 * The HTTP entry (``http-entry.ts``) was added in 0.2.0 for remote
 * MCP hosts (Claude.ai Custom Connector et al). ``index.ts`` now
 * chooses between the two based on the ``--transport`` flag or the
 * ``MCP_TRANSPORT`` env var. Stdio remains the default — any caller
 * that invoked ``npx @cueapi/mcp`` before 0.2.0 gets the exact same
 * behavior on upgrade.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import { CueAPIClient, CueAPIError } from "./client.js";
import { tools } from "./tools.js";

export async function runStdio(): Promise<void> {
  const apiKey = process.env.CUEAPI_API_KEY;
  if (!apiKey) {
    console.error(
      "[cueapi-mcp] CUEAPI_API_KEY env var is required. Generate one at https://cueapi.ai"
    );
    process.exit(1);
  }

  const client = new CueAPIClient({
    apiKey,
    baseUrl: process.env.CUEAPI_BASE_URL,
  });

  const server = new Server(
    {
      name: "cueapi-mcp",
      version: "0.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const toolListResponse = {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema, { target: "jsonSchema7" }),
    })),
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => toolListResponse);

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Unknown tool: ${request.params.name}` },
        ],
        isError: true,
      };
    }

    try {
      const parsed = tool.schema.parse(request.params.arguments ?? {});
      // Stdio: the single client is authenticated from the env var,
      // pass-through to the handler.
      const result = await tool.handler(client, parsed);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return formatToolError(tool.name, err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Don't log on success — MCP stdio hosts treat stderr output as diagnostic.
}

function formatToolError(toolName: string, err: unknown) {
  if (err instanceof z.ZodError) {
    return {
      content: [
        {
          type: "text",
          text: `Invalid arguments for ${toolName}:\n${JSON.stringify(
            err.issues,
            null,
            2
          )}`,
        },
      ],
      isError: true,
    };
  }
  if (err instanceof CueAPIError) {
    return {
      content: [
        {
          type: "text",
          text: `CueAPI error (${err.status}): ${err.message}\n${JSON.stringify(
            err.body,
            null,
            2
          )}`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `Unexpected error in ${toolName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    ],
    isError: true,
  };
}
