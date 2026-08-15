/**
 * Shared "fall back to API key for the rest of today" switch used by both the
 * search and fetch providers. Exa's free MCP tier rate-limits anonymous
 * requests per IP (low QPS + a daily quota), and once that daily quota is
 * exhausted the remaining anonymous calls for the day keep failing. So instead
 * of retrying each single call, we flip a sticky flag: the first time today's
 * anonymous request hits the rate-limit signal, we switch keyed the rest of
 * the day. The next calendar day resets back to anonymous automatically.
 *
 * The state is process-local in-memory: a process restart resumes anonymous,
 * which matches the "for the rest of today" semantics for the process lifetime.
 * No file persistence, no timers, no clocks beyond the local date label.
 * @module dsh-web-exa/switch
 */

/** A local `yyyy-mm-dd` date label for "today". */
function today(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * Sticky per-day anonymous→keyed switch. Created once in the plugin `apply` and
 * shared by the search and fetch providers so that when either tool trips the
 * daily rate limit, both switch for the rest of the day (Exa's quota is shared
 * per IP across tools).
 */
export class AnonymousSwitch {
  private switchedOnDay: string | undefined;

  /** True when the switch has been tripped earlier today. */
  isSwitched(): boolean {
    return this.switchedOnDay === today();
  }

  /** Flip the switch for today (idempotent; only records today's date). */
  switchOn(): void {
    this.switchedOnDay = today();
  }

  /** Expose "today" for tests that need to pin the day boundary. */
  static today(): string {
    return today();
  }
}

/**
 * True when an Exa MCP tool-call response is a free-tier rate-limit rejection,
 * judged from the raw HTTP status and, when body parsing succeeds, the
 * JSON-RPC `error.message`. The Exa MCP server returns HTTP 429 with a
 * JSON-RPC error whose message contains "rate limit". We deliberately require
 * a distinctive signal so generic failures never trip the switch.
 */
export function isRateLimited(status: number, parsedError?: { message?: string }): boolean {
  if (status === 429) return true;
  const message = parsedError?.message;
  if (message === undefined || message.length === 0) return false;
  return /rate limit/i.test(message);
}

/**
 * Thrown when an Exa MCP tool call is rejected because the anonymous free tier
 * hit its rate limit. Both provider `fetch`/`search` catch it to flip the
 * per-day switch and retry once with an API key.
 */
export class ExaRateLimitedError extends Error {
  constructor() {
    super("Exa free MCP rate limit exceeded");
    this.name = "ExaRateLimitedError";
  }
}

/** Parse a non-OK JSON body into the JSON-RPC error envelope for `isRateLimited`. */
export function parseNonOkError(body: string): { error?: { message?: string } } {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return { error: parsed.error };
  } catch {
    return {};
  }
}
