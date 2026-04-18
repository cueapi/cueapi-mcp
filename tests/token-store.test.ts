import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SQLiteTokenStore,
  decryptApiKey,
  encryptApiKey,
  signState,
  verifyState,
} from "../src/token-store.js";

const SECRET = "a-forty-character-signing-secret-for-tests!!!";

describe("encryptApiKey / decryptApiKey", () => {
  it("round-trips a cue_sk_ plaintext", () => {
    const plaintext = "cue_sk_1234567890abcdef1234567890abcdef";
    const encrypted = encryptApiKey(plaintext, SECRET);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted.length).toBeGreaterThan(plaintext.length);
    expect(decryptApiKey(encrypted, SECRET)).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (IV randomization)", () => {
    const plaintext = "cue_sk_example";
    const a = encryptApiKey(plaintext, SECRET);
    const b = encryptApiKey(plaintext, SECRET);
    expect(a).not.toBe(b);
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const plaintext = "cue_sk_foo";
    const encrypted = encryptApiKey(plaintext, SECRET);
    // Tamper one byte in the middle of the payload.
    const buf = Buffer.from(encrypted, "base64");
    buf[buf.length - 5] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptApiKey(tampered, SECRET)).toThrow();
  });

  it("rejects decryption with the wrong secret", () => {
    const encrypted = encryptApiKey("cue_sk_x", SECRET);
    expect(() => decryptApiKey(encrypted, "wrong-secret-of-sufficient-length!!!!")).toThrow();
  });
});

describe("signState / verifyState", () => {
  it("round-trips a payload", () => {
    const payload = { clientState: "abc", codeChallenge: "xyz", issuedAt: 123 };
    const signed = signState(payload, SECRET);
    const verified = verifyState<typeof payload>(signed, SECRET);
    expect(verified).toEqual(payload);
  });

  it("rejects tampered body", () => {
    const signed = signState({ a: 1 }, SECRET);
    const [body, sig] = signed.split(".");
    const tamperedBody = body.slice(0, -1) + (body.at(-1) === "A" ? "B" : "A");
    expect(verifyState(`${tamperedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects tampered signature", () => {
    const signed = signState({ a: 1 }, SECRET);
    const [body] = signed.split(".");
    const fakeSig = "x".repeat(43);
    expect(verifyState(`${body}.${fakeSig}`, SECRET)).toBeNull();
  });

  it("rejects signature from a different secret", () => {
    const signed = signState({ a: 1 }, "secret-one-of-sufficient-length!!!!!!!");
    expect(verifyState(signed, "secret-two-of-sufficient-length!!!!!!!")).toBeNull();
  });
});

describe("SQLiteTokenStore", () => {
  let path: string;
  let store: SQLiteTokenStore;

  beforeEach(() => {
    path = join(tmpdir(), `cueapi-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new SQLiteTokenStore(path, SECRET);
  });

  afterEach(async () => {
    await store.close();
    try {
      unlinkSync(path);
      unlinkSync(`${path}-wal`);
      unlinkSync(`${path}-shm`);
    } catch {
      // ignore
    }
  });

  it("requires signing secret of at least 32 chars", () => {
    expect(() => new SQLiteTokenStore(path, "short")).toThrow();
  });

  describe("auth codes", () => {
    it("stores, reads, deletes", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setAuthCode("code-abc", {
        apiKey: "cue_sk_test",
        codeChallenge: "chal-xyz",
        redirectUri: "https://claude.ai/callback",
        clientId: "claude-client",
        createdAt: now,
        expiresAt: now + 60,
      });
      const entry = await store.getAuthCode("code-abc");
      expect(entry).not.toBeNull();
      expect(entry!.apiKey).toBe("cue_sk_test");
      expect(entry!.codeChallenge).toBe("chal-xyz");

      await store.deleteAuthCode("code-abc");
      expect(await store.getAuthCode("code-abc")).toBeNull();
    });

    it("returns null for expired codes", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setAuthCode("code-stale", {
        apiKey: "cue_sk_t",
        codeChallenge: "c",
        redirectUri: "r",
        clientId: "x",
        createdAt: now - 120,
        expiresAt: now - 1, // already expired
      });
      expect(await store.getAuthCode("code-stale")).toBeNull();
    });
  });

  describe("access tokens", () => {
    it("round-trips full entry", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setAccessToken("tok-1", {
        apiKey: "cue_sk_access",
        userId: "user-123",
        clientId: "claude-client",
        refreshToken: "refresh-1",
        createdAt: now,
        expiresAt: now + 86400,
      });
      const entry = await store.getAccessToken("tok-1");
      expect(entry).not.toBeNull();
      expect(entry!.apiKey).toBe("cue_sk_access");
      expect(entry!.userId).toBe("user-123");
      expect(entry!.refreshToken).toBe("refresh-1");
    });
  });

  describe("refresh tokens", () => {
    it("round-trips full entry", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setRefreshToken("refresh-1", {
        apiKey: "cue_sk_refresh",
        userId: "user-456",
        clientId: "claude-client",
        createdAt: now,
        expiresAt: now + 30 * 86400,
      });
      const entry = await store.getRefreshToken("refresh-1");
      expect(entry).not.toBeNull();
      expect(entry!.apiKey).toBe("cue_sk_refresh");
    });
  });

  describe("cleanup", () => {
    it("drops only expired rows", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setAuthCode("fresh", {
        apiKey: "a", codeChallenge: "c", redirectUri: "r", clientId: "x",
        createdAt: now, expiresAt: now + 60,
      });
      await store.setAuthCode("stale", {
        apiKey: "a", codeChallenge: "c", redirectUri: "r", clientId: "x",
        createdAt: now - 200, expiresAt: now - 100,
      });
      const deleted = await store.cleanup();
      expect(deleted).toBe(1);
      expect(await store.getAuthCode("fresh")).not.toBeNull();
      expect(await store.getAuthCode("stale")).toBeNull();
    });
  });

  describe("encryption at rest", () => {
    it("stores ciphertext, not plaintext, in the DB file", async () => {
      const now = Math.floor(Date.now() / 1000);
      await store.setAuthCode("enc-check", {
        apiKey: "cue_sk_ABCXYZ_very_distinctive_plaintext",
        codeChallenge: "c", redirectUri: "r", clientId: "x",
        createdAt: now, expiresAt: now + 60,
      });
      await store.close();

      // Read the raw file bytes and confirm the plaintext does NOT appear.
      const { readFileSync } = await import("node:fs");
      const raw = readFileSync(path);
      expect(raw.includes(Buffer.from("cue_sk_ABCXYZ_very_distinctive_plaintext"))).toBe(false);

      // Reopen and verify it decrypts correctly.
      store = new SQLiteTokenStore(path, SECRET);
      const entry = await store.getAuthCode("enc-check");
      expect(entry!.apiKey).toBe("cue_sk_ABCXYZ_very_distinctive_plaintext");
    });
  });
});
