import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
} from "@deepseek-ai/dsh-web";
import { AnonymousSwitch, ExaRateLimitedError, isRateLimited, parseNonOkError } from "./switch.js";

/**
 * Exa MCP fetch provider. Calls Exa's hosted MCP endpoint
 * (`https://mcp.exa.ai/mcp`) over JSON-RPC `tools/call` with the `web_fetch_exa`
 * tool, retrieving a page as Exa's clean rendered markdown. Anonymous by default;
 * an optional `EXA_API_KEY` (or literal `apiKey`) is appended as a query
 * parameter when present, mirroring `dsh-web-exa/search`.
 *
 * The wire format is the provider's MCP server; this module owns only the
 * JSON-RPC call, SSE/JSON parsing, and the mapping of Exa's rendered block
 * (`# Title`, `URL: ...`, then the body) into the seam's normalized
 * `WebFetchResult`.
 * @module dsh-web-exa/fetch
 */

/** Stable id this provider registers under. */
export const EXA_FETCH_PROVIDER_ID = "exa-fetch";

/** Default Exa hosted MCP endpoint. */
export const EXA_FETCH_DEFAULT_BASE_URL = "https://mcp.exa.ai/mcp";

/** Environment variable naming this provider's optional API key. */
export const EXA_FETCH_API_KEY_ENV = "EXA_API_KEY";

/** Default maximum characters extracted per page (raised above Exa's 3000 MCP default). */
export const EXA_FETCH_DEFAULT_MAX_CHARACTERS = 15000;

/** Default cooperative timeout budget for one fetch call (ms). */
export const EXA_FETCH_DEFAULT_TIMEOUT_MS = 30000;

/** Resolved provider options for one fetch operation. */
export interface ExaFetchProviderOptions {
  /** Literal API key; when present it wins over `resolveApiKey`. */
  readonly apiKey?: string;
  /** Resolve the current API key for one fetch operation. */
  readonly resolveApiKey?: () => Promise<string | undefined>;
  /** MCP endpoint base URL. */
  readonly baseURL: string;
  /** Maximum characters to extract per page. */
  readonly maxCharacters?: number;
  /** Timeout budget (ms). */
  readonly timeoutMs: number;
}

/** JSON-RPC response envelope carrying the MCP tool result. */
interface McpResponse {
  readonly result?: {
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: string;
    }[];
  };
  readonly error?: {
    readonly message?: string;
  };
}

/**
 * Parse a `web_fetch_exa` result: a markdown block like
 *
 * ```text
 * # Example Domain
 * URL: https://example.com
 * Published: 2024-01-01
 *
 * <body>
 * ```
 *
 * Returns the body kind (always `text`, since Exa yields clean markdown), the
 * body content, and the first URL found. Falls back to the request URL when no
 * `URL:` line is present.
 */
function parseFetchResult(
  text: string,
  fallbackUrl: string,
): { content: string; url: string } {
  const lines = text.split(/\r?\n/u);
  let url: string | undefined;
  const bodyParts: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const urlMatch: RegExpMatchArray | null = /^URL:\s*(\S+)\s*$/u.exec(line);
    if (urlMatch !== null && urlMatch[1].length > 0 && url === undefined) {
      url = urlMatch[1];
      continue;
    }
    bodyParts.push(line);
  }
  const content = bodyParts.join("\n").trim();
  return { content, url: url ?? fallbackUrl };
}

/**
 * Extract the `result.content[].text` payload from an Exa MCP response. The
 * endpoint answers either as a single JSON body or as `text/event-stream` with
 * `data:` frames; the first frame carrying content text wins.
 */
function parseMcpResponse(body: string): string | undefined {
  const decode = (payload: string): string | undefined => {
    try {
      const data = JSON.parse(payload) as McpResponse;
      if (data.error !== undefined) {
        throw new WebError(`Exa fetch MCP error: ${data.error.message ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
      }
      return data.result?.content?.find((item) => item.type === "text" && item.text !== undefined)?.text;
    } catch (error) {
      if (error instanceof WebError) throw error;
      return undefined;
    }
  };

  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    const direct = decode(trimmed);
    if (direct !== undefined) return direct;
  }
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const frame = decode(line.substring("data: ".length));
    if (frame !== undefined) return frame;
  }
  return undefined;
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Throw the provider's stable cancellation error when the caller aborted. */
function throwIfFetchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw fetchAborted(signal);
}

/** Build the provider's stable cancellation error. */
function fetchAborted(signal: AbortSignal): WebError {
  return new WebError("Exa fetch aborted", "WEB_ABORTED", { cause: signal.reason });
}

/** Combine caller cancellation and the operation timeout budget; never `undefined`. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (signal === undefined) return AbortSignal.timeout(timeoutMs);
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/**
 * The Exa MCP fetch provider. Non-successful MCP tool responses resolve
 * descriptively; transport failures surface as `WEB_PROVIDER_ERROR`.
 */
export class ExaFetchProvider implements WebFetchProvider {
  readonly id = EXA_FETCH_PROVIDER_ID;

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one fetch never mixes two settings.
   * @param sw - optional shared per-day anonymous→keyed switch. When provided,
   * fetches default to anonymous and flip to the API key for the rest of the
   * day after the first rate-limit rejection. Omit it to always use the
   * configured credential directly.
   */
  constructor(
    private readonly resolveOptions: () => ExaFetchProviderOptions,
    private readonly sw: AnonymousSwitch | undefined = undefined,
  ) {}

  available(): boolean {
    const options = this.resolveOptions();
    return (
      URL.canParse(options.baseURL) &&
      Number.isInteger(options.timeoutMs) &&
      options.timeoutMs > 0
    );
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    const options = this.resolveOptions();
    throwIfFetchAborted(signal);

    let url: URL;
    try {
      url = new URL(request.url);
    } catch (error) {
      throw new WebError(`Invalid URL: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new WebError(`Unsupported URL protocol: ${url.protocol}`, "WEB_PROVIDER_ERROR");
    }

    const arguments_ = {
      urls: [url.toString()],
      ...(options.maxCharacters !== undefined ? { maxCharacters: options.maxCharacters } : {}),
    };

    // Without a switch, always use the configured credential directly (legacy
    // behavior). With a switch: once today's switch is tripped, stay keyed.
    const configured = this.sw === undefined;
    const alreadySwitched = this.sw !== undefined && this.sw.isSwitched();
    let keyValue: string | undefined;
    if (configured || alreadySwitched) {
      keyValue = await this.apiKey(options, signal);
      throwIfFetchAborted(signal);
    }

    try {
      const payload = await this.callMcp(options, arguments_, keyValue, signal);
      const { content, url: finalUrl } = parseFetchResult(payload, url.toString());
      return {
        url: finalUrl,
        statusCode: 200,
        body: { kind: "text", content },
        truncated: false,
      };
    } catch (error) {
      // Anonymous request hit the rate limit and we haven't switched yet today:
      // flip the switch and retry once with the API key.
      if (error instanceof ExaRateLimitedError && !alreadySwitched && this.sw !== undefined) {
        let fallbackKey: string | undefined;
        try {
          fallbackKey = await this.apiKey(options, signal);
          throwIfFetchAborted(signal);
        } catch {
          throw error; // no usable key (or cancelled) — surface the original rate-limit
        }
        if (fallbackKey === undefined) {
          throw new WebError("Exa free MCP rate limit exceeded; no API key configured to fall back to", "WEB_PROVIDER_ERROR");
        }
        this.sw.switchOn();
        const payload = await this.callMcp(options, arguments_, fallbackKey, signal);
        const { content, url: finalUrl } = parseFetchResult(payload, url.toString());
        return {
          url: finalUrl,
          statusCode: 200,
          body: { kind: "text", content },
          truncated: false,
        };
      }
      throw error;
    }
  }

  /** Run one `web_fetch_exa` MCP call; returns the parsed text payload. */
  private async callMcp(
    options: ExaFetchProviderOptions,
    arguments_: Record<string, unknown>,
    keyValue: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    throwIfFetchAborted(signal);

    const endpoint = new URL(options.baseURL);
    if (keyValue !== undefined) endpoint.searchParams.set("exaApiKey", keyValue);

    const requestSignal = withTimeout(signal, options.timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_fetch_exa",
            arguments: arguments_,
          },
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted || isAbortError(error)) throw fetchAborted(requestSignal);
      if (error instanceof WebError) throw error;
      throw new WebError(`Exa fetch request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    if (!response.ok) {
      const body = await this.readBody(response, requestSignal);
      const envelope = parseNonOkError(body);
      if (isRateLimited(response.status, envelope.error)) throw new ExaRateLimitedError();
      throw new WebError(
        envelope.error?.message ?? `Exa fetch API error (HTTP ${response.status})`,
        "WEB_PROVIDER_ERROR",
      );
    }

    const text = await this.readBody(response, requestSignal);
    const payload = parseMcpResponse(text);
    if (payload === undefined) {
      throw new WebError("Exa returned no fetch content; the URL may not have been retrievable", "WEB_PROVIDER_ERROR");
    }
    return payload;
  }

  /** Read the response body, translating aborts to `WEB_ABORTED`. */
  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      if (signal.aborted === true || isAbortError(error)) throw fetchAborted(signal);
      throw new WebError(`Exa fetch response body failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }

  /** Resolve one operation's credential without retaining it on the provider. */
  private async apiKey(options: ExaFetchProviderOptions, signal: AbortSignal | undefined): Promise<string | undefined> {
    throwIfFetchAborted(signal);
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
    try {
      const resolved = await options.resolveApiKey?.();
      if (resolved !== undefined && resolved.length > 0) return resolved;
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal ?? new AbortController().signal);
      throw new WebError(`Exa fetch credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    return undefined;
  }
}
