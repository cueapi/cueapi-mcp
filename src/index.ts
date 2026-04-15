#!/usr/bin/env node
/**
 * CueAPI MCP server.
 *
 * Speaks the Model Context Protocol over stdio and exposes CueAPI's
 * core surface as MCP tools. Configure in your MCP host (Claude Desktop,
 * Cursor, etc.) with:
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
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Build the JSON-schema tool list once up front.
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
    if (err instanceof z.ZodError) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid arguments for ${tool.name}:\n${JSON.stringify(
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
          text: `Unexpected error in ${tool.name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Don't log on success — MCP stdio hosts treat stderr output as diagnostic.
}

main().catch((err) => {
  console.error("[cueapi-mcp] fatal:", err);
  process.exit(1);
});
