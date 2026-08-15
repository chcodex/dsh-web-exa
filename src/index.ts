import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-web";
import {
  ExaSearchProvider,
  EXA_API_KEY_ENV,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_CONTEXT_MAX_CHARACTERS,
  EXA_DEFAULT_LIVECRAWL,
  EXA_DEFAULT_NUM_RESULTS,
  EXA_DEFAULT_TIMEOUT_MS,
  EXA_DEFAULT_TYPE,
  EXA_PROVIDER_ID,
} from "./provider.js";
import type { ExaSearchProviderOptions } from "./provider.js";
import {
  ExaFetchProvider,
  EXA_FETCH_API_KEY_ENV,
  EXA_FETCH_DEFAULT_BASE_URL,
  EXA_FETCH_DEFAULT_MAX_CHARACTERS,
  EXA_FETCH_DEFAULT_TIMEOUT_MS,
  EXA_FETCH_PROVIDER_ID,
} from "./fetch.js";
import type { ExaFetchProviderOptions } from "./fetch.js";
import { AnonymousSwitch } from "./switch.js";

/**
 * Register Exa-backed search and fetch providers in `ctx.web`. Search calls
 * Exa's hosted MCP endpoint (`https://mcp.exa.ai/mcp`) with the `web_search_exa`
 * tool; fetch calls it with the `web_fetch_exa` tool, mirroring OpenCode's
 * default websearch and webfetch backends. Anonymous by default; an optional
 * `EXA_API_KEY` environment variable or literal `apiKey` enables authenticated
 * requests. Coexists with the official `deepseek-official` provider; selection
 * follows the `ctx.web` rules (configured `searchProvider`/`fetchProvider` or
 * sole usable one).
 * @module dsh-web-exa
 */

export {
  ExaSearchProvider,
  EXA_API_KEY_ENV,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_CONTEXT_MAX_CHARACTERS,
  EXA_DEFAULT_LIVECRAWL,
  EXA_DEFAULT_NUM_RESULTS,
  EXA_DEFAULT_TIMEOUT_MS,
  EXA_DEFAULT_TYPE,
  EXA_PROVIDER_ID,
} from "./provider.js";
export type { ExaSearchProviderOptions } from "./provider.js";

export {
  ExaFetchProvider,
  EXA_FETCH_API_KEY_ENV,
  EXA_FETCH_DEFAULT_BASE_URL,
  EXA_FETCH_DEFAULT_MAX_CHARACTERS,
  EXA_FETCH_DEFAULT_TIMEOUT_MS,
  EXA_FETCH_PROVIDER_ID,
} from "./fetch.js";
export type { ExaFetchProviderOptions } from "./fetch.js";

export { AnonymousSwitch } from "./switch.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-exa";

/** The web seam this provider registers into. */
export const inject = ["web"];

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Exa API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string;
  /** Environment variable name for the API key; defaults to `EXA_API_KEY`. */
  apiKeyEnv?: string;
  /** Exa MCP endpoint base URL; defaults to `https://mcp.exa.ai/mcp`. */
  baseURL?: string;
  /** Number of results to request from Exa; defaults to 8. */
  numResults?: number;
  /** Exa search type; defaults to `auto`. */
  type?: string;
  /** Exa live crawl mode; defaults to `fallback`. */
  livecrawl?: string;
  /** Context character cap per result; defaults to 10000. */
  contextMaxCharacters?: number;
  /** Cooperative timeout budget (ms); defaults to 25000. */
  timeoutMs?: number;
  /** Literal Exa API key for fetch; prefer {@link fetchApiKeyEnv}. */
  fetchApiKey?: string;
  /** Environment variable name for the fetch API key; defaults to `EXA_API_KEY`. */
  fetchApiKeyEnv?: string;
  /** Exa MCP endpoint base URL for fetch; defaults to `https://mcp.exa.ai/mcp`. */
  fetchBaseURL?: string;
  /** Maximum characters extracted per fetched page; defaults to 3000. */
  fetchMaxCharacters?: number;
  /** Fetch timeout budget (ms); defaults to 30000. */
  fetchTimeoutMs?: number;
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role("secret"),
  apiKeyEnv: z.string().default(EXA_API_KEY_ENV),
  baseURL: z.string().default(EXA_DEFAULT_BASE_URL),
  numResults: z.number().step(1).min(1).max(10).default(EXA_DEFAULT_NUM_RESULTS),
  type: z.string().default(EXA_DEFAULT_TYPE),
  livecrawl: z.string().default(EXA_DEFAULT_LIVECRAWL),
  contextMaxCharacters: z.number().step(1).min(100).max(100000).default(EXA_DEFAULT_CONTEXT_MAX_CHARACTERS),
  timeoutMs: z.number().step(1).min(1000).max(60000).default(EXA_DEFAULT_TIMEOUT_MS),
  fetchApiKey: z.string().role("secret"),
  fetchApiKeyEnv: z.string().default(EXA_FETCH_API_KEY_ENV),
  fetchBaseURL: z.string().default(EXA_FETCH_DEFAULT_BASE_URL),
  fetchMaxCharacters: z.number().step(1).min(100).max(100000).default(EXA_FETCH_DEFAULT_MAX_CHARACTERS),
  fetchTimeoutMs: z.number().step(1).min(1000).max(60000).default(EXA_FETCH_DEFAULT_TIMEOUT_MS),
});

/** Settings namespace carrying this provider's endpoint and key reference. */
export const EXA_SETTINGS_NAMESPACE = settingsNamespace(name);

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(config: Config): ExaSearchProviderOptions {
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined;
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const value = process.env[config.apiKeyEnv ?? EXA_API_KEY_ENV];
      return value !== undefined && value.length > 0 ? value : undefined;
    },
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    numResults: config.numResults ?? EXA_DEFAULT_NUM_RESULTS,
    type: (config.type ?? EXA_DEFAULT_TYPE) as "auto" | "fast" | "deep",
    livecrawl: (config.livecrawl ?? EXA_DEFAULT_LIVECRAWL) as "fallback" | "preferred",
    contextMaxCharacters: config.contextMaxCharacters ?? EXA_DEFAULT_CONTEXT_MAX_CHARACTERS,
    timeoutMs: config.timeoutMs ?? EXA_DEFAULT_TIMEOUT_MS,
  };
}

/** Project one resolved section into the options the fetch provider serves its next fetch with. */
function resolveFetchOptions(config: Config): ExaFetchProviderOptions {
  const literalApiKey = config.fetchApiKey !== undefined && config.fetchApiKey.length > 0 ? config.fetchApiKey : undefined;
  return {
    ...(literalApiKey === undefined ? {} : { apiKey: literalApiKey }),
    resolveApiKey: async () => {
      const value = process.env[config.fetchApiKeyEnv ?? EXA_FETCH_API_KEY_ENV];
      return value !== undefined && value.length > 0 ? value : undefined;
    },
    baseURL: config.fetchBaseURL ?? EXA_FETCH_DEFAULT_BASE_URL,
    maxCharacters: config.fetchMaxCharacters ?? EXA_FETCH_DEFAULT_MAX_CHARACTERS,
    timeoutMs: config.fetchTimeoutMs ?? EXA_FETCH_DEFAULT_TIMEOUT_MS,
  };
}

/** Register the Exa search and fetch providers with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config;
  installSettingsSection(ctx, EXA_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source;
    },
    // The registration carries no resolved value: the provider projects the
    // section per search, so a committed change needs no re-registration.
    onChange: () => {},
  });
  // Shared per-day anonymous→keyed switch: both providers default to anonymous
  // and flip to the API key for the rest of the day once either trips the free
  // tier rate limit. The next day both automatically resume anonymous.
  const sw = new AnonymousSwitch();
  ctx.web.registerSearchProvider(new ExaSearchProvider(() => resolveOptions(current()), sw));
  ctx.web.registerFetchProvider(new ExaFetchProvider(() => resolveFetchOptions(current()), sw));
}
