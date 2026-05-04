import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CueAPIError } from "../src/client.js";
import { formatToolError } from "../src/stdio-entry.js";

// formatToolError is the single place that turns server-side errors
// into the { content, isError } structure the MCP host shows in the
// agent's transcript. A regression here means an agent sees a blank
// or misleading message instead of a debuggable one — worth pinning.

describe("formatToolError — MCP tool error envelope", () => {
  it("zod validation errors surface the issues array", () => {
    const schema = z.object({ cue_id: z.string().min(1) });
    let caught: unknown;
    try {
      schema.parse({ cue_id: "" });
    } catch (e) {
      caught = e;
    }

    const result = formatToolError("cueapi_get_cue", caught);

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    expect(text).toContain("Invalid arguments for cueapi_get_cue");
    // The raw issues array must be present so the agent can read the
    // specific field that failed (path) and the code ('too_small').
    expect(text).toContain("too_small");
  });

  it("CueAPIError surfaces status, message, and body", () => {
    const err = new CueAPIError(
      "Cue not found",
      404,
      { error: { code: "cue_not_found", message: "Cue not found" } }
    );

    const result = formatToolError("cueapi_get_cue", err);

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("CueAPI error (404)");
    expect(text).toContain("Cue not found");
    // The server's error envelope must come through so the agent can
    // distinguish 'cue_not_found' from 'cue_limit_exceeded' by code.
    expect(text).toContain("cue_not_found");
  });

  it("generic Error uses its message", () => {
    const err = new Error("network boom");
    const result = formatToolError("cueapi_create_cue", err);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Unexpected error in cueapi_create_cue"
    );
    expect(result.content[0].text).toContain("network boom");
  });

  it("non-Error thrown values are coerced with String()", () => {
    const result = formatToolError("cueapi_list_cues", "bare string threw");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bare string threw");
  });

  it("returns content of type 'text' (MCP protocol requirement)", () => {
    for (const err of [
      new Error("a"),
      new CueAPIError("b", 500, {}),
      "c",
      42,
    ]) {
      const result = formatToolError("t", err);
      expect(result.content[0].type).toBe("text");
    }
  });
});
