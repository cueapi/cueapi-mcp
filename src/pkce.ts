/**
 * PKCE S256 verifier (RFC 7636) for the Stage C OAuth 2.1 flow.
 *
 * Claude.ai (and any well-behaved OAuth client) sends a
 * ``code_challenge`` on ``/authorize`` and proves possession of the
 * corresponding ``code_verifier`` on ``/token``. We support S256 only —
 * ``plain`` is explicitly rejected because it adds zero security over
 * not using PKCE at all.
 */

import { createHash } from "node:crypto";

/**
 * Compute the S256 code_challenge for a given verifier.
 * Spec: BASE64URL-ENCODE(SHA256(ASCII(verifier))).
 */
export function computeCodeChallengeS256(verifier: string): string {
  const digest = createHash("sha256").update(verifier, "ascii").digest();
  return base64UrlEncode(digest);
}

/**
 * Verify that the caller's verifier matches the stored challenge.
 * Returns true on match, false otherwise. Constant-time comparison
 * via Buffer.compare isn't strictly needed here (the challenge and
 * verifier are ephemeral per authorization code), but we use it
 * anyway — cheap and nicer for defense in depth.
 */
export function verifyCodeChallenge(
  verifier: string,
  expectedChallenge: string,
  method: "S256" | "plain" = "S256"
): boolean {
  if (method !== "S256") {
    // Plain is rejected even if the caller advertises it — callers
    // who want PKCE must do it correctly.
    return false;
  }
  // Spec says verifier length must be 43-128 chars from the unreserved
  // URL set. We don't police character set here (it's not a security
  // boundary), but the length check catches obvious garbage.
  if (verifier.length < 43 || verifier.length > 128) {
    return false;
  }
  const computed = computeCodeChallengeS256(verifier);
  if (computed.length !== expectedChallenge.length) {
    return false;
  }
  return constantTimeEqual(computed, expectedChallenge);
}

/**
 * Base64url encode (RFC 4648 §5) — no padding, ``+`` → ``-``, ``/`` → ``_``.
 */
export function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Base64url decode — reverse of ``base64UrlEncode``.
 */
export function base64UrlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padding), "base64");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
