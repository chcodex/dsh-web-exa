import { WebError } from "@deepseek-ai/dsh-web";
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from "@deepseek-ai/dsh-web";
import { AnonymousSwitch, ExaRateLimitedError, isRateLimited, parseNonOkError } from "./switch.js";

/**
 * Exa-backed search provider. Calls Exa's hosted MCP endpoint
 * (`https://mcp.exa.ai/mcp`) over JSON-RPC `tools/call` with the `web_search_exa`
 * tool, mirroring OpenCode's default websearch backend. Anonymous by default;
 * an optional `EXA_API_KEY` (or literal `apiKey`) is appended as a query
 * parameter when present.
 *
 * The wire format is the provider's MCP server; this module owns only the
 * JSON-RPC call, SSE/JSON parsing, and the mapping of Exa's rendered text
 * blocks (`Title:/URL:/Published:/Highlights:`, `---` separated) into the
 * seam's normalized `sources[]`.
 * @module dsh-web-exa/search
 */

/** Stable id this provider registers under. */
export const EXA_PROVIDER_ID = "exa";

/** Default Exa hosted MCP endpoint. */
export const EXA_DEFAULT_BASE_URL = "https://mcp.exa.ai/mcp";

/** Environment variable naming this provider's optional API key. */
export const EXA_API_KEY_ENV = "EXA_API_KEY";

/** Default number of search results requested from Exa. */
export const EXA_DEFAULT_NUM_RESULTS = 8;

/** Default search type passed to Exa (`auto` | `fast` | `deep`). */
export const EXA_DEFAULT_TYPE = "auto";

/** Default live crawl mode (`fallback` | `preferred`). */
export const EXA_DEFAULT_LIVECRAWL = "fallback";

/** Default maximum characters of context per result. */
export const EXA_DEFAULT_CONTEXT_MAX_CHARACTERS = 10000;

/** Default cooperative timeout budget for one search call (ms). */
export const EXA_DEFAULT_TIMEOUT_MS = 25000;

/** Upper bound on snippet length carried into `sources[].snippet`. */
const SNIPPET_MAX_LENGTH = 300;

/** Resolved provider options for one search operation. */
export interface ExaSearchProviderOptions {
  /** Literal API key; when present it wins over `resolveApiKey`. */
  readonly apiKey?: string;
  /** Resolve the current API key for one search operation. */
  readonly resolveApiKey?: () => Promise<string | undefined>;
  /** MCP endpoint base URL. */
  readonly baseURL: string;
  /** Number of results to request. */
  readonly numResults: number;
  /** Exa search type. */
  readonly type: "auto" | "fast" | "deep";
  /** Exa live crawl mode. */
  readonly livecrawl: "fallback" | "preferred";
  /** Context character cap per result. */
  readonly contextMaxCharacters?: number;
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
 * Parse one search result text block into a normalized source. The block looks
 * like:
 *
 * ```text
 * Title: ...
 * URL: https://...
 * Published: N/A
 * Author: N/A
 * Highlights:
 * <multiline excerpt>
 * ```
 *
 * Metadata lines are collected until `Highlights:`; everything after it is the
 * snippet text. Returns `undefined` when the block carries no URL.
 */
function parseSourceBlock(block: string): WebSearchSource | undefined {
  const lines = block.split(/\r?\n/u);
  let title: string | undefined;
  let url: string | undefined;
  let publishedAt: string | undefined;
  const highlights: string[] = [];
  let inHighlights = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!inHighlights) {
      const meta = /^([A-Za-z]+):\s*(.*)$/u.exec(line);
      if (meta) {
        const [, key, value] = meta;
        switch (key) {
          case "Title":
            title = value.length > 0 ? value : undefined;
            continue;
          case "URL":
            url = value.length > 0 ? value : undefined;
            continue;
          case "Published":
            publishedAt =
              value.length > 0 && value !== "N/A" && value !== "n/a" ? value : undefined;
            continue;
          case "Highlights":
            inHighlights = true;
            continue;
          default:
            continue;
        }
      }
    }
    highlights.push(line);
  }
  if (url === undefined || url.length === 0) return undefined;
  const snippet = highlights.join(" ").replace(/\s+/gu, " ").trim();
  return {
    url,
    ...(title !== undefined && title.length > 0 ? { title } : {}),
    ...(snippet.length > 0 ? { snippet: snippet.slice(0, SNIPPET_MAX_LENGTH) } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

/**
 * Parse Exa's rendered search results into normalized sources. Results are
 * separated by a `---` divider line; each block is parsed independently and
 * non-citeable blocks are skipped. The snippet is the block's `Highlights`
 * excerpt (deduped across blocks is unnecessary: Exa returns distinct pages).
 */
export function parseExaText(text: string): WebSearchSource[] {
  const blocks = text.split(/^---[ \t]*$/gmu);
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const source = parseSourceBlock(block);
    if (source === undefined) continue;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return sources;
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
        throw new WebError(`Exa search MCP error: ${data.error.message ?? "unknown error"}`, "WEB_PROVIDER_ERROR");
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
function throwIfSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error. */
function searchAborted(signal: AbortSignal): WebError {
  return new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal.reason });
}

/** Combine caller cancellation and the operation timeout budget; never `undefined`. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (signal === undefined) return AbortSignal.timeout(timeoutMs);
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class ExaSearchProvider implements WebSearchProvider {
  readonly id = EXA_PROVIDER_ID;

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two settings.
   * @param sw - optional shared per-day anonymous→keyed switch. When provided,
   * searches default to anonymous and flip to the API key for the rest of the
   * day after the first rate-limit rejection. Omit it to always use the
   * configured credential directly.
   */
  constructor(
    private readonly resolveOptions: () => ExaSearchProviderOptions,
    private readonly sw: AnonymousSwitch | undefined = undefined,
  ) {}

  available(): boolean {
    const options = this.resolveOptions();
    return (
      URL.canParse(options.baseURL) &&
      Number.isInteger(options.numResults) &&
      options.numResults > 0 &&
      Number.isInteger(options.timeoutMs) &&
      options.timeoutMs > 0
    );
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions();
    throwIfSearchAborted(signal);

    const arguments_ = {
      query: request.query,
      type: options.type,
      numResults: Math.min(options.numResults, request.maxResults ?? options.numResults),
      livecrawl: options.livecrawl,
      ...(options.contextMaxCharacters !== undefined ? { contextMaxCharacters: options.contextMaxCharacters } : {}),
    };

    // Without a switch, always use the configured credential directly (legacy
    // behavior). With a switch: once today's switch is tripped, stay keyed.
    const configured = this.sw === undefined;
    const alreadySwitched = this.sw !== undefined && this.sw.isSwitched();
    let keyValue: string | undefined;
    if (configured || alreadySwitched) {
      keyValue = await this.apiKey(options, signal);
      throwIfSearchAborted(signal);
    }

    try {
      const payload = await this.callMcp(options, arguments_, keyValue, signal);
      return this.toResult(payload);
    } catch (error) {
      // Anonymous request hit the rate limit and we haven't switched yet today:
      // flip the switch and retry once with the API key.
      if (error instanceof ExaRateLimitedError && !alreadySwitched && this.sw !== undefined) {
        let fallbackKey: string | undefined;
        try {
          fallbackKey = await this.apiKey(options, signal);
          throwIfSearchAborted(signal);
        } catch {
          throw error; // no usable key (or cancelled) — surface the original rate-limit
        }
        if (fallbackKey === undefined) {
          throw new WebError("Exa free MCP rate limit exceeded; no API key configured to fall back to", "WEB_PROVIDER_ERROR");
        }
        this.sw.switchOn();
        const payload = await this.callMcp(options, arguments_, fallbackKey, signal);
        return this.toResult(payload);
      }
      throw error;
    }
  }

  /** Run one `web_search_exa` MCP call; returns the parsed text payload. */
  private async callMcp(
    options: ExaSearchProviderOptions,
    arguments_: Record<string, unknown>,
    keyValue: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    throwIfSearchAborted(signal);

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
            name: "web_search_exa",
            arguments: arguments_,
          },
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (requestSignal.aborted || isAbortError(error)) throw searchAborted(requestSignal);
      if (error instanceof WebError) throw error;
      throw new WebError(`Exa search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }

    if (!response.ok) {
      const body = await this.readBody(response, requestSignal);
      const envelope = parseNonOkError(body);
      if (isRateLimited(response.status, envelope.error)) throw new ExaRateLimitedError();
      throw new WebError(
        envelope.error?.message ?? `Exa search API error (HTTP ${response.status})`,
        "WEB_PROVIDER_ERROR",
      );
    }

    const text = await this.readBody(response, requestSignal);
    const payload = parseMcpResponse(text);
    if (payload === undefined) {
      throw new WebError("Exa returned no text content; the request may not have produced search results", "WEB_PROVIDER_ERROR");
    }
    return payload;
  }

  /** Read the response body, translating aborts to `WEB_ABORTED`. */
  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      if (signal.aborted === true || isAbortError(error)) throw searchAborted(signal);
      throw new WebError(`Exa search response body failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }

  /** Map the parsed Exa payload plus a non-empty-sources passthrough into a result. */
  private toResult(payload: string): WebSearchResult {
    const sources = parseExaText(payload);
    if (sources.length === 0) {
      return { content: payload, sources: [], truncated: false };
    }
    return { sources, truncated: false };
  }

  /** Resolve one operation's credential without retaining it on the provider. */
  private async apiKey(options: ExaSearchProviderOptions, signal: AbortSignal | undefined): Promise<string | undefined> {
    throwIfSearchAborted(signal);
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey;
    try {
      const resolved = await options.resolveApiKey?.();
      if (resolved !== undefined && resolved.length > 0) return resolved;
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal ?? new AbortController().signal);
      throw new WebError(`Exa search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    return undefined;
  }
}
