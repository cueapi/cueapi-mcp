/**
 * Token store for the Stage C OAuth flow.
 *
 * Three kinds of entries:
 *
 *   auth_code    — short-lived (60s) code returned to the OAuth client's
 *                  redirect_uri after /callback/cueapi. Exchanged for an
 *                  access_token via /token (with PKCE verifier). Single-use.
 *
 *   access_token — 24h bearer token the OAuth client presents on /mcp
 *                  calls. We look up the CueAPI api_key from this row and
 *                  hand it to the per-request CueAPIClient.
 *
 *   refresh_token — 30d token to mint new access_tokens without the user
 *                   re-doing the magic-link dance.
 *
 * The CueAPI ``api_key`` stored on each row is encrypted at rest with
 * AES-256-GCM using a key derived from ``OAUTH_SIGNING_SECRET`` via
 * HKDF — this way an attacker who exfiltrates the SQLite file without
 * the signing secret can't use the tokens to talk to CueAPI.
 *
 * Default backend is SQLite (zero-config, file-backed at
 * ``SQLITE_PATH`` or ``./mcp-tokens.db``). A Redis backend can be added
 * later without changing the ``TokenStore`` interface.
 */

import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface AuthCodeEntry {
  /** The CueAPI api_key minted for this OAuth session. */
  apiKey: string;
  /** S256 code_challenge sent on /authorize — verified on /token. */
  codeChallenge: string;
  /** The OAuth client's redirect_uri (Anthropic's). */
  redirectUri: string;
  /** The OAuth client's client_id (Anthropic's). */
  clientId: string;
  createdAt: number; // unix seconds
  expiresAt: number;
}

export interface AccessTokenEntry {
  apiKey: string;
  userId: string;
  clientId: string;
  refreshToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface RefreshTokenEntry {
  apiKey: string;
  userId: string;
  clientId: string;
  createdAt: number;
  expiresAt: number;
}

export interface TokenStore {
  setAuthCode(code: string, data: AuthCodeEntry): Promise<void>;
  getAuthCode(code: string): Promise<AuthCodeEntry | null>;
  deleteAuthCode(code: string): Promise<void>;

  setAccessToken(token: string, data: AccessTokenEntry): Promise<void>;
  getAccessToken(token: string): Promise<AccessTokenEntry | null>;
  deleteAccessToken(token: string): Promise<void>;

  setRefreshToken(token: string, data: RefreshTokenEntry): Promise<void>;
  getRefreshToken(token: string): Promise<RefreshTokenEntry | null>;
  deleteRefreshToken(token: string): Promise<void>;

  /** Drop all expired rows. Called on an interval from http-entry. */
  cleanup(): Promise<number>;

  /** Release resources. Used in tests. */
  close(): Promise<void>;
}

// ---------- encryption ----------

const ENCRYPTION_INFO = "cueapi-mcp/token-store/api-key-encryption";
const KEY_SIZE = 32; // AES-256
const IV_SIZE = 12; // GCM standard
const TAG_SIZE = 16;

function deriveEncryptionKey(signingSecret: string): Buffer {
  // HKDF-style derivation via scrypt (Node lacks a first-class HKDF in
  // every supported version; scrypt is strictly stronger as a KDF and
  // good enough here).
  return scryptSync(signingSecret, ENCRYPTION_INFO, KEY_SIZE);
}

export function encryptApiKey(plaintext: string, signingSecret: string): string {
  const key = deriveEncryptionKey(signingSecret);
  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv || tag || ciphertext, base64 — self-contained.
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptApiKey(payload: string, signingSecret: string): string {
  const key = deriveEncryptionKey(signingSecret);
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_SIZE + TAG_SIZE) {
    throw new Error("Encrypted api_key payload is truncated");
  }
  const iv = buf.subarray(0, IV_SIZE);
  const tag = buf.subarray(IV_SIZE, IV_SIZE + TAG_SIZE);
  const ct = buf.subarray(IV_SIZE + TAG_SIZE);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

/**
 * Sign a state blob for the outer ``/authorize`` → cueapi.ai magic-link
 * redirect. We wrap Anthropic's state + the PKCE challenge in our own
 * HMAC-SHA256-signed envelope so a malicious party can't tamper with
 * the return trip to our ``/callback/cueapi``.
 */
export function signState(payload: object, signingSecret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", signingSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState<T = unknown>(
  signed: string,
  signingSecret: string
): T | null {
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac("sha256", signingSecret)
    .update(body)
    .digest("base64url");
  if (sig.length !== expected.length) return null;
  let ok = 0;
  for (let i = 0; i < sig.length; i++) {
    ok |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (ok !== 0) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------- SQLite implementation ----------

export class SQLiteTokenStore implements TokenStore {
  private readonly db: Database.Database;
  private readonly signingSecret: string;

  constructor(path: string, signingSecret: string) {
    if (!signingSecret || signingSecret.length < 32) {
      throw new Error(
        "OAUTH_SIGNING_SECRET must be at least 32 characters for AES-256 derivation"
      );
    }
    this.signingSecret = signingSecret;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_codes (
        code TEXT PRIMARY KEY,
        api_key_enc TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

      CREATE TABLE IF NOT EXISTS access_tokens (
        token TEXT PRIMARY KEY,
        api_key_enc TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens(expires_at);

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        api_key_enc TEXT NOT NULL,
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
    `);
  }

  async setAuthCode(code: string, data: AuthCodeEntry): Promise<void> {
    const enc = encryptApiKey(data.apiKey, this.signingSecret);
    this.db
      .prepare(
        `INSERT INTO auth_codes
         (code, api_key_enc, code_challenge, redirect_uri, client_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(code, enc, data.codeChallenge, data.redirectUri, data.clientId, data.createdAt, data.expiresAt);
  }

  async getAuthCode(code: string): Promise<AuthCodeEntry | null> {
    const row = this.db
      .prepare(
        `SELECT api_key_enc, code_challenge, redirect_uri, client_id, created_at, expires_at
         FROM auth_codes WHERE code = ?`
      )
      .get(code) as any;
    if (!row) return null;
    if (row.expires_at < nowSec()) {
      this.db.prepare(`DELETE FROM auth_codes WHERE code = ?`).run(code);
      return null;
    }
    return {
      apiKey: decryptApiKey(row.api_key_enc, this.signingSecret),
      codeChallenge: row.code_challenge,
      redirectUri: row.redirect_uri,
      clientId: row.client_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteAuthCode(code: string): Promise<void> {
    this.db.prepare(`DELETE FROM auth_codes WHERE code = ?`).run(code);
  }

  async setAccessToken(token: string, data: AccessTokenEntry): Promise<void> {
    const enc = encryptApiKey(data.apiKey, this.signingSecret);
    this.db
      .prepare(
        `INSERT INTO access_tokens
         (token, api_key_enc, user_id, client_id, refresh_token, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(token, enc, data.userId, data.clientId, data.refreshToken, data.createdAt, data.expiresAt);
  }

  async getAccessToken(token: string): Promise<AccessTokenEntry | null> {
    const row = this.db
      .prepare(
        `SELECT api_key_enc, user_id, client_id, refresh_token, created_at, expires_at
         FROM access_tokens WHERE token = ?`
      )
      .get(token) as any;
    if (!row) return null;
    if (row.expires_at < nowSec()) {
      this.db.prepare(`DELETE FROM access_tokens WHERE token = ?`).run(token);
      return null;
    }
    return {
      apiKey: decryptApiKey(row.api_key_enc, this.signingSecret),
      userId: row.user_id,
      clientId: row.client_id,
      refreshToken: row.refresh_token,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteAccessToken(token: string): Promise<void> {
    this.db.prepare(`DELETE FROM access_tokens WHERE token = ?`).run(token);
  }

  async setRefreshToken(token: string, data: RefreshTokenEntry): Promise<void> {
    const enc = encryptApiKey(data.apiKey, this.signingSecret);
    this.db
      .prepare(
        `INSERT INTO refresh_tokens
         (token, api_key_enc, user_id, client_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(token, enc, data.userId, data.clientId, data.createdAt, data.expiresAt);
  }

  async getRefreshToken(token: string): Promise<RefreshTokenEntry | null> {
    const row = this.db
      .prepare(
        `SELECT api_key_enc, user_id, client_id, created_at, expires_at
         FROM refresh_tokens WHERE token = ?`
      )
      .get(token) as any;
    if (!row) return null;
    if (row.expires_at < nowSec()) {
      this.db.prepare(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
      return null;
    }
    return {
      apiKey: decryptApiKey(row.api_key_enc, this.signingSecret),
      userId: row.user_id,
      clientId: row.client_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteRefreshToken(token: string): Promise<void> {
    this.db.prepare(`DELETE FROM refresh_tokens WHERE token = ?`).run(token);
  }

  async cleanup(): Promise<number> {
    const now = nowSec();
    const results = [
      this.db.prepare(`DELETE FROM auth_codes WHERE expires_at < ?`).run(now),
      this.db.prepare(`DELETE FROM access_tokens WHERE expires_at < ?`).run(now),
      this.db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ?`).run(now),
    ];
    return results.reduce((acc, r) => acc + r.changes, 0);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
