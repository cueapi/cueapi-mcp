/**
 * Minimal CueAPI HTTP client used by the MCP server.
 *
 * We deliberately avoid adding the cueapi-sdk as a dependency — MCP servers
 * should be tiny and self-contained so they cold-start fast under Claude
 * Desktop and other hosts.
 */

export interface CueAPIClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export class CueAPIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "CueAPIError";
  }
}

export class CueAPIClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: CueAPIClientOptions) {
    if (!opts.apiKey) {
      throw new Error("CUEAPI_API_KEY is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.cueapi.ai").replace(/\/$/, "");
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | null,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(
            ([k, v]) =>
              `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
          )
          .join("&")
      : "";

    const url = `${this.baseUrl}${path}${qs}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "cueapi-mcp/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      throw new CueAPIError(
        `CueAPI ${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
        parsed
      );
    }

    return parsed as T;
  }
}
