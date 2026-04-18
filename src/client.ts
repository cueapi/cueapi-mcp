/**
 * Minimal CueAPI HTTP client used by the MCP server.
 *
 * We deliberately avoid adding the cueapi-sdk as a dependency — MCP servers
 * should be tiny and self-contained so they cold-start fast under Claude
 * Desktop and other hosts.
 *
 * 0.2.0 (HTTP transport) changes:
 *
 *   - The constructor's ``apiKey`` is now OPTIONAL. In stdio mode it
 *     comes from ``CUEAPI_API_KEY`` once at boot and is reused for
 *     every request. In HTTP mode each incoming ``/mcp`` request
 *     carries its own bearer token (looked up in the token store from
 *     the OAuth access_token), so the key is passed on every
 *     ``request()`` call as the optional ``apiKey`` argument.
 *
 *   - ``request()`` accepts a trailing ``apiKey`` that, when provided,
 *     overrides the constructor's default. Callers in HTTP mode
 *     always pass it; callers in stdio mode can omit.
 */

export interface CueAPIClientOptions {
  apiKey?: string;
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
  private readonly defaultApiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: CueAPIClientOptions = {}) {
    this.defaultApiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.cueapi.ai").replace(/\/$/, "");
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | null,
    query?: Record<string, string | number | boolean | undefined>,
    apiKey?: string
  ): Promise<T> {
    const effectiveKey = apiKey ?? this.defaultApiKey;
    if (!effectiveKey) {
      throw new Error(
        "No API key available. Provide one to the constructor (stdio mode) " +
        "or pass it on the request call (HTTP mode)."
      );
    }

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
        Authorization: `Bearer ${effectiveKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "cueapi-mcp/0.2.0",
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
