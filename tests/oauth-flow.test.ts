/**
 * End-to-end OAuth flow test — walks the Claude.ai → cueapi-mcp
 * dance without contacting the real cueapi.ai endpoint. Uses the
 * ``fetchApiKeyFromSession`` override on ``buildApp`` so the
 * /callback/cueapi handler doesn't need a live network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import supertest from "supertest";

import { buildApp } from "../src/http-entry.js";
import { SQLiteTokenStore } from "../src/token-store.js";
import { computeCodeChallengeS256 } from "../src/pkce.js";

const SECRET = "a-forty-character-signing-secret-for-oauth!!!";

const baseConfig = {
  port: 0,
  publicUrl: "https://mcp.test.example",
  cueapiBaseUrl: "https://api.cueapi.ai",
  oauthSigningSecret: SECRET,
  sqlitePath: "",
  allowedClaudeAiClientIds: new Set(["claude-ai-test"]),
  cueapiMcpClientId: "cueapi-mcp-instance-1",
  cueapiMcpExchangeEndpoint: "https://api.cueapi.ai/v1/auth/mcp-exchange",
};

function freshVerifier() {
  // 43-char minimum; use 64 random chars.
  return randomBytes(48).toString("base64url").slice(0, 64);
}

describe("OAuth flow", () => {
  let dbPath: string;
  let store: SQLiteTokenStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `oauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SQLiteTokenStore(dbPath, SECRET);
    app = buildApp({
      store,
      config: { ...baseConfig, sqlitePath: dbPath },
      fetchApiKeyFromSession: async () => ({
        apiKey: "cue_sk_testauth",
        userId: "user-abc-def",
      }),
    });
  });

  afterEach(async () => {
    await store.close();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  describe("GET /health", () => {
    it("returns healthy", async () => {
      const res = await supertest(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.transport).toBe("http");
    });
  });

  describe("GET /.well-known/oauth-authorization-server", () => {
    it("advertises S256-only PKCE + authorization_code grant", async () => {
      const res = await supertest(app).get("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      expect(res.body.code_challenge_methods_supported).toEqual(["S256"]);
      expect(res.body.grant_types_supported).toContain("authorization_code");
      expect(res.body.authorization_endpoint).toBe("https://mcp.test.example/authorize");
    });
  });

  describe("GET /authorize", () => {
    it("redirects to cueapi.ai magic-link with signed state for valid request", async () => {
      const verifier = freshVerifier();
      const challenge = computeCodeChallengeS256(verifier);
      const res = await supertest(app).get("/authorize").query({
        response_type: "code",
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/oauth/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "anthropic-state-opaque",
        scope: "mcp",
      });
      expect(res.status).toBe(302);
      const loc = res.headers.location;
      expect(loc).toContain("api.cueapi.ai/auth/magic-link");
      const url = new URL(loc);
      expect(url.searchParams.get("return_to")).toBe("https://mcp.test.example/callback/cueapi");
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("rejects unsupported response_type", async () => {
      const res = await supertest(app).get("/authorize").query({
        response_type: "token",
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "x".repeat(43),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unsupported_response_type");
    });

    it("rejects unknown client_id", async () => {
      const res = await supertest(app).get("/authorize").query({
        response_type: "code",
        client_id: "random-untrusted-client",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "x".repeat(43),
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("unauthorized_client");
    });

    it("rejects missing code_challenge (PKCE mandatory)", async () => {
      const res = await supertest(app).get("/authorize").query({
        response_type: "code",
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/cb",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("rejects plain code_challenge_method", async () => {
      const res = await supertest(app).get("/authorize").query({
        response_type: "code",
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "plain",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });
  });

  describe("Full authorize → callback → token → /mcp flow", () => {
    async function runAuthorize(verifier: string, anthropicState: string) {
      const challenge = computeCodeChallengeS256(verifier);
      const res = await supertest(app).get("/authorize").query({
        response_type: "code",
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/oauth/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: anthropicState,
        scope: "mcp",
      });
      expect(res.status).toBe(302);
      const url = new URL(res.headers.location);
      return url.searchParams.get("state")!;
    }

    async function runCallback(wrappedState: string, sessionToken: string) {
      const res = await supertest(app).get("/callback/cueapi").query({
        session_token: sessionToken,
        state: wrappedState,
      });
      expect(res.status).toBe(302);
      const url = new URL(res.headers.location);
      expect(url.hostname).toBe("claude.ai");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      return { code, returnedState };
    }

    async function runTokenExchange(code: string, verifier: string) {
      const res = await supertest(app).post("/token").type("form").send({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "claude-ai-test",
        redirect_uri: "https://claude.ai/oauth/callback",
      });
      return res;
    }

    it("happy path end-to-end", async () => {
      const verifier = freshVerifier();
      const wrappedState = await runAuthorize(verifier, "anthropic-state-opaque");
      const { code, returnedState } = await runCallback(wrappedState, "session-from-magic-link");

      expect(code).toBeTruthy();
      expect(returnedState).toBe("anthropic-state-opaque");

      const tok = await runTokenExchange(code!, verifier);
      expect(tok.status).toBe(200);
      expect(tok.body.access_token).toBeTruthy();
      expect(tok.body.token_type).toBe("Bearer");
      expect(tok.body.expires_in).toBe(86400);
      expect(tok.body.refresh_token).toBeTruthy();
    });

    it("/token rejects wrong PKCE verifier", async () => {
      const verifier = freshVerifier();
      const wrappedState = await runAuthorize(verifier, "state-x");
      const { code } = await runCallback(wrappedState, "session-x");
      const badVerifier = freshVerifier();
      const tok = await runTokenExchange(code!, badVerifier);
      expect(tok.status).toBe(400);
      expect(tok.body.error).toBe("invalid_grant");
    });

    it("/token rejects used auth code (single-use)", async () => {
      const verifier = freshVerifier();
      const wrappedState = await runAuthorize(verifier, "state-y");
      const { code } = await runCallback(wrappedState, "session-y");
      const first = await runTokenExchange(code!, verifier);
      expect(first.status).toBe(200);
      const second = await runTokenExchange(code!, verifier);
      expect(second.status).toBe(400);
      expect(second.body.error).toBe("invalid_grant");
    });

    it("/callback rejects tampered state", async () => {
      const verifier = freshVerifier();
      const wrappedState = await runAuthorize(verifier, "state-t");
      const tampered = wrappedState.slice(0, -3) + "XXX";
      const res = await supertest(app).get("/callback/cueapi").query({
        session_token: "x",
        state: tampered,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });
  });

  describe("POST /mcp bearer auth", () => {
    it("401s without bearer token", async () => {
      const res = await supertest(app).post("/mcp").send({});
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("Bearer");
    });

    it("401s with unknown token", async () => {
      const res = await supertest(app)
        .post("/mcp")
        .set("Authorization", "Bearer definitely-not-a-real-token")
        .send({});
      expect(res.status).toBe(401);
    });
  });
});
