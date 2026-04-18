/**
 * HTTP transport entry point — new in 0.2.0.
 *
 * Purpose: let remote MCP hosts (Claude.ai Custom Connector, any other
 * OAuth-speaking MCP client) talk to cueapi-mcp over HTTP/SSE instead
 * of spawning a local subprocess. Stdio mode (0.1.x) is preserved
 * unchanged via ``stdio-entry.ts``.
 *
 * Endpoints:
 *
 *   GET  /health
 *   GET  /.well-known/oauth-authorization-server      (RFC 8414 metadata)
 *   GET  /authorize                                    (OAuth 2.1 + PKCE entry)
 *   GET  /callback/cueapi                              (post magic-link)
 *   POST /token                                        (exchange code → access_token)
 *   POST /mcp                                          (MCP protocol)
 *
 * OAuth flow (numbered to match the inline spec comments below):
 *
 *   1. Claude.ai → GET /authorize with code_challenge + redirect_uri + state
 *   2. We sign (Anthropic's state + challenge + redirect_uri) and redirect the
 *      user to cueapi.ai's magic-link flow, passing return_to=our-callback
 *      and our own signed state.
 *   3. User completes magic-link. cueapi.ai redirects to /callback/cueapi
 *      with their session_token + our signed state.
 *   4. We verify our state signature, extract the wrapped PKCE challenge +
 *      Anthropic's state, and POST to cueapi.ai /v1/auth/mcp-exchange
 *      with the session_token + our registered client_id. Response is the
 *      user's new CueAPI api_key.
 *   5. We mint a random auth_code, store (code, api_key, code_challenge,
 *      redirect_uri, client_id, expires_at=60s) in the token store, and
 *      redirect the user to Anthropic's redirect_uri with ?code=... &state=...
 *   6. Claude.ai → POST /token with auth_code + code_verifier
 *   7. We verify the PKCE challenge, delete the auth_code (single-use),
 *      mint access_token (24h) + refresh_token (30d), store both with the
 *      api_key encrypted at rest, and return them to Anthropic.
 *   8. Claude.ai → POST /mcp with Authorization: Bearer <access_token>
 *      We look up the api_key, create a per-request CueAPIClient, and
 *      hand the MCP StreamableHTTPServerTransport the request.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { createHmac, randomBytes } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import { CueAPIClient, CueAPIError } from "./client.js";
import { tools } from "./tools.js";
import { verifyCodeChallenge } from "./pkce.js";
import {
  SQLiteTokenStore,
  signState,
  verifyState,
  type TokenStore,
} from "./token-store.js";

const AUTH_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 86400; // 24h
const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400; // 30d
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ---------- env parsing ----------

interface HttpConfig {
  port: number;
  publicUrl: string;
  cueapiBaseUrl: string;
  oauthSigningSecret: string;
  sqlitePath: string;
  allowedClaudeAiClientIds: Set<string>;
  cueapiMcpClientId: string;
  cueapiMcpExchangeEndpoint: string;
}

function loadConfig(): HttpConfig {
  const missing: string[] = [];
  const req = (key: string): string => {
    const v = process.env[key];
    if (!v) missing.push(key);
    return v || "";
  };

  const publicUrl = (process.env.MCP_PUBLIC_URL || "").replace(/\/$/, "");
  if (!publicUrl) missing.push("MCP_PUBLIC_URL");
  const oauthSigningSecret = req("OAUTH_SIGNING_SECRET");
  const allowedRaw = req("ALLOWED_CLAUDE_AI_CLIENT_IDS");
  const cueapiMcpClientId = req("CUEAPI_MCP_CLIENT_ID");

  if (missing.length > 0) {
    throw new Error(
      `HTTP transport requires these env vars: ${missing.join(", ")}. See README for the full list.`
    );
  }
  if (oauthSigningSecret.length < 32) {
    throw new Error("OAUTH_SIGNING_SECRET must be at least 32 characters.");
  }

  return {
    port: parseInt(process.env.MCP_PORT || "3000", 10),
    publicUrl,
    cueapiBaseUrl: (process.env.CUEAPI_BASE_URL || "https://api.cueapi.ai").replace(/\/$/, ""),
    oauthSigningSecret,
    sqlitePath: process.env.SQLITE_PATH || "./mcp-tokens.db",
    allowedClaudeAiClientIds: new Set(
      allowedRaw.split(",").map((s) => s.trim()).filter(Boolean)
    ),
    cueapiMcpClientId: cueapiMcpClientId,
    cueapiMcpExchangeEndpoint:
      process.env.CUEAPI_MCP_EXCHANGE_ENDPOINT ||
      `${(process.env.CUEAPI_BASE_URL || "https://api.cueapi.ai").replace(/\/$/, "")}/v1/auth/mcp-exchange`,
  };
}

// ---------- app factory (exported for tests) ----------

export interface HttpAppDeps {
  store: TokenStore;
  config: HttpConfig;
  /** Optional override for tests: skip the real cueapi.ai redirect. */
  fetchApiKeyFromSession?: (sessionToken: string) => Promise<{ apiKey: string; userId: string }>;
}

export function buildApp({ store, config, fetchApiKeyFromSession }: HttpAppDeps) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  // Inject config so handlers don't close over the outer scope.
  app.locals.config = config;
  app.locals.store = store;

  // ---- GET /health ----
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "healthy",
      version: "0.2.0",
      transport: "http",
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  // ---- GET /.well-known/oauth-authorization-server ----
  // RFC 8414 — describes our OAuth surface to clients that introspect it.
  app.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: config.publicUrl,
      authorization_endpoint: `${config.publicUrl}/authorize`,
      token_endpoint: `${config.publicUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  // ---- GET /authorize ----
  // Step 1 of the OAuth flow. Claude.ai redirects the user's browser here.
  app.get("/authorize", async (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } =
      req.query as Record<string, string | undefined>;

    if (response_type !== "code") {
      return sendOAuthError(res, "unsupported_response_type", "Only response_type=code is supported.");
    }
    if (!client_id || !config.allowedClaudeAiClientIds.has(client_id)) {
      return sendOAuthError(res, "unauthorized_client", "client_id is not an approved OAuth client.");
    }
    if (!redirect_uri) {
      return sendOAuthError(res, "invalid_request", "redirect_uri is required.");
    }
    if (!code_challenge) {
      return sendOAuthError(res, "invalid_request", "code_challenge is required (PKCE mandatory).");
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      return sendOAuthError(res, "invalid_request", "code_challenge_method must be S256.");
    }

    // Sign an envelope that wraps the client's state + PKCE material.
    // cueapi.ai's magic-link flow will round-trip this untouched; we
    // verify the signature on /callback/cueapi to prevent tampering.
    const wrappedState = signState(
      {
        clientState: state || "",
        codeChallenge: code_challenge,
        redirectUri: redirect_uri,
        clientId: client_id,
        scope: scope || "mcp",
        issuedAt: Math.floor(Date.now() / 1000),
      },
      config.oauthSigningSecret
    );

    // Redirect to cueapi.ai magic-link entry with our callback URL and
    // signed state. The actual magic-link UI on cueapi.ai handles the
    // email-and-code dance; we just care about the session_token on the
    // other side.
    const callbackUrl = `${config.publicUrl}/callback/cueapi`;
    const redirect = new URL("/auth/magic-link", config.cueapiBaseUrl);
    redirect.searchParams.set("return_to", callbackUrl);
    redirect.searchParams.set("state", wrappedState);
    res.redirect(302, redirect.toString());
  });

  // ---- GET /callback/cueapi ----
  // Step 3. cueapi.ai redirected the user back after magic-link success.
  app.get("/callback/cueapi", async (req: Request, res: Response) => {
    const { session_token, state } = req.query as Record<string, string | undefined>;
    if (!session_token || !state) {
      return sendOAuthError(res, "invalid_request", "session_token and state are required.");
    }

    // 3a. Verify our signed state envelope.
    const unwrapped = verifyState<{
      clientState: string;
      codeChallenge: string;
      redirectUri: string;
      clientId: string;
      scope: string;
      issuedAt: number;
    }>(state, config.oauthSigningSecret);
    if (!unwrapped) {
      return sendOAuthError(res, "invalid_request", "State signature is invalid or tampered.");
    }
    // State shouldn't be older than 15 minutes — user who leaves their
    // magic-link email sitting open for an hour needs to restart.
    if (Math.floor(Date.now() / 1000) - unwrapped.issuedAt > 900) {
      return sendOAuthError(res, "invalid_request", "Authorization state expired. Please retry.");
    }

    // 3b. Exchange session_token for a scoped CueAPI api_key via the
    // Stage B endpoint on cueapi.ai.
    let apiKey: string;
    let userId: string;
    try {
      const result = fetchApiKeyFromSession
        ? await fetchApiKeyFromSession(session_token)
        : await exchangeSessionTokenForApiKey({
            sessionToken: session_token,
            clientId: unwrapped.clientId,
            exchangeEndpoint: config.cueapiMcpExchangeEndpoint,
            cueapiMcpClientId: config.cueapiMcpClientId,
          });
      apiKey = result.apiKey;
      userId = result.userId;
    } catch (err: any) {
      return sendOAuthError(
        res,
        "server_error",
        `CueAPI exchange failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 5. Mint an auth_code, store (code, apiKey, challenge, ...), redirect to Anthropic.
    const authCode = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    await store.setAuthCode(authCode, {
      apiKey,
      codeChallenge: unwrapped.codeChallenge,
      redirectUri: unwrapped.redirectUri,
      clientId: unwrapped.clientId,
      createdAt: now,
      expiresAt: now + AUTH_CODE_TTL_SECONDS,
    });
    // Ferry Anthropic's original client state back untouched.
    const anthropicRedirect = new URL(unwrapped.redirectUri);
    anthropicRedirect.searchParams.set("code", authCode);
    if (unwrapped.clientState) {
      anthropicRedirect.searchParams.set("state", unwrapped.clientState);
    }
    // Best-effort: stash userId in a server-side memo for later ops.
    // (We don't put it in the URL — that leaks PII into browser history.)
    void userId;
    res.redirect(302, anthropicRedirect.toString());
  });

  // ---- POST /token ----
  // Step 6. Claude.ai exchanges the auth_code for an access_token using the PKCE verifier.
  app.post("/token", async (req: Request, res: Response) => {
    const { grant_type } = req.body as { grant_type?: string };
    if (grant_type === "authorization_code") {
      return handleAuthCodeGrant(req, res, store, config);
    }
    if (grant_type === "refresh_token") {
      return handleRefreshGrant(req, res, store, config);
    }
    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "grant_type must be authorization_code or refresh_token.",
    });
  });

  // ---- POST /mcp ----
  // Step 8. Claude.ai speaks MCP protocol with Bearer <access_token>.
  app.post("/mcp", bearerAuth(store), async (req: Request, res: Response) => {
    const apiKey = (req as any).apiKey as string;
    const client = new CueAPIClient({
      apiKey,
      baseUrl: config.cueapiBaseUrl,
    });

    const server = buildMcpServerForRequest(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — each request is its own session
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}

// ---------- OAuth grant handlers ----------

async function handleAuthCodeGrant(
  req: Request,
  res: Response,
  store: TokenStore,
  config: HttpConfig
) {
  const { code, code_verifier, client_id, redirect_uri } = req.body as Record<string, string | undefined>;
  if (!code || !code_verifier) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const entry = await store.getAuthCode(code);
  if (!entry) {
    return res.status(400).json({ error: "invalid_grant", error_description: "auth code not found or expired" });
  }

  // PKCE verification.
  if (!verifyCodeChallenge(code_verifier, entry.codeChallenge, "S256")) {
    // Don't delete the code yet — an attacker shouldn't be able to DoS a
    // legit caller by submitting a wrong verifier. But the code does
    // expire naturally within 60s, so this bounded.
    return res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
  }

  // client_id + redirect_uri must match the /authorize request that
  // created this code.
  if (client_id && client_id !== entry.clientId) {
    return res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
  }
  if (redirect_uri && redirect_uri !== entry.redirectUri) {
    return res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
  }

  // Mint access + refresh tokens.
  const accessToken = randomToken(40);
  const refreshToken = randomToken(40);
  const now = Math.floor(Date.now() / 1000);

  // Single-use — delete the auth code now.
  await store.deleteAuthCode(code);

  await store.setAccessToken(accessToken, {
    apiKey: entry.apiKey,
    userId: "", // not known at this point; refreshed on /mcp lookup if needed
    clientId: entry.clientId,
    refreshToken,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  await store.setRefreshToken(refreshToken, {
    apiKey: entry.apiKey,
    userId: "",
    clientId: entry.clientId,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS,
  });

  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: "mcp",
  });
}

async function handleRefreshGrant(
  req: Request,
  res: Response,
  store: TokenStore,
  config: HttpConfig
) {
  const { refresh_token } = req.body as Record<string, string | undefined>;
  if (!refresh_token) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const entry = await store.getRefreshToken(refresh_token);
  if (!entry) {
    return res.status(400).json({ error: "invalid_grant", error_description: "refresh_token not found or expired" });
  }

  const accessToken = randomToken(40);
  const now = Math.floor(Date.now() / 1000);
  await store.setAccessToken(accessToken, {
    apiKey: entry.apiKey,
    userId: entry.userId,
    clientId: entry.clientId,
    refreshToken: refresh_token,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    scope: "mcp",
  });
}

// ---------- middleware: bearer auth from access_token ----------

function bearerAuth(store: TokenStore) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="mcp", error="invalid_token"')
        .end();
    }
    const token = m[1].trim();
    const entry = await store.getAccessToken(token);
    if (!entry) {
      return res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="mcp", error="invalid_token"')
        .end();
    }
    (req as any).apiKey = entry.apiKey;
    (req as any).accessTokenEntry = entry;
    next();
  };
}

// ---------- MCP server per-request ----------

function buildMcpServerForRequest(client: CueAPIClient) {
  const server = new Server(
    { name: "cueapi-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } }
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
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const parsed = tool.schema.parse(request.params.arguments ?? {});
      const result = await tool.handler(client, parsed);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      if (err instanceof z.ZodError) {
        return {
          content: [{ type: "text", text: `Invalid arguments:\n${JSON.stringify(err.issues, null, 2)}` }],
          isError: true,
        };
      }
      if (err instanceof CueAPIError) {
        return {
          content: [{ type: "text", text: `CueAPI error (${err.status}): ${err.message}\n${JSON.stringify(err.body, null, 2)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------- helpers ----------

async function exchangeSessionTokenForApiKey(args: {
  sessionToken: string;
  clientId: string;
  exchangeEndpoint: string;
  cueapiMcpClientId: string;
}): Promise<{ apiKey: string; userId: string }> {
  const res = await fetch(args.exchangeEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_token: args.sessionToken,
      client_id: args.cueapiMcpClientId,
      label: args.clientId, // pass through the OAuth client for labeling
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) {
    throw new Error(
      `mcp-exchange responded ${res.status}: ${body?.error?.message || JSON.stringify(body)}`
    );
  }
  return { apiKey: body.api_key, userId: body.user_id };
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sendOAuthError(res: Response, code: string, description: string) {
  res.status(400).json({ error: code, error_description: description });
}

// ---------- main entry (called by index.ts when --transport=http) ----------

export async function runHttp(): Promise<void> {
  const config = loadConfig();
  const store = new SQLiteTokenStore(config.sqlitePath, config.oauthSigningSecret);

  // Periodic cleanup of expired rows.
  const cleanupTimer = setInterval(() => {
    store.cleanup().catch((err) => console.error("[cueapi-mcp] cleanup failed:", err));
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  const app = buildApp({ store, config });
  const server = app.listen(config.port, () => {
    console.error(
      `[cueapi-mcp] HTTP transport listening on :${config.port} (public URL: ${config.publicUrl})`
    );
  });

  // Graceful shutdown.
  const shutdown = async () => {
    clearInterval(cleanupTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
