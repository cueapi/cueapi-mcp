import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  computeCodeChallengeS256,
  verifyCodeChallenge,
} from "../src/pkce.js";

describe("pkce", () => {
  describe("computeCodeChallengeS256", () => {
    it("matches RFC 7636 appendix B example", () => {
      // Spec test vector.
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
      expect(computeCodeChallengeS256(verifier)).toBe(expectedChallenge);
    });

    it("is deterministic", () => {
      const v = "some-random-verifier-at-least-43-characters-long";
      expect(computeCodeChallengeS256(v)).toBe(computeCodeChallengeS256(v));
    });
  });

  describe("verifyCodeChallenge", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    it("accepts matching verifier with S256", () => {
      expect(verifyCodeChallenge(verifier, challenge, "S256")).toBe(true);
    });

    it("rejects tampered verifier", () => {
      const tampered = verifier.slice(0, -1) + "X";
      expect(verifyCodeChallenge(tampered, challenge, "S256")).toBe(false);
    });

    it("rejects plain method even if verifier == challenge", () => {
      expect(verifyCodeChallenge("anything", "anything", "plain" as any)).toBe(false);
    });

    it("rejects verifier shorter than 43 chars", () => {
      expect(verifyCodeChallenge("too-short", challenge, "S256")).toBe(false);
    });

    it("rejects verifier longer than 128 chars", () => {
      const tooLong = "x".repeat(129);
      expect(verifyCodeChallenge(tooLong, challenge, "S256")).toBe(false);
    });
  });

  describe("base64url round-trip", () => {
    it("encodes and decodes cleanly with padding", () => {
      const original = Buffer.from("hello world with some padding needed!!");
      const encoded = base64UrlEncode(original);
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      const decoded = base64UrlDecode(encoded);
      expect(decoded.equals(original)).toBe(true);
    });
  });
});
