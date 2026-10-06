// Feature flags / kill switches (INFRA.md #9, docs/ANALYTICS.md).
//
// Remote evaluation uses PostHog's public flags endpoint and the same project API key as the web loader
// (POSTHOG_KEY, phc_…). That key is not a secret. Local evaluation is not used: it needs a personal API key,
// and this Worker must not have one. An env var for each flag always wins, including when PostHog is down.
//
// Each flag says what to do when the key is missing, the host is refused, the lookup fails, or PostHog
// does not return that flag:
//   open   — the value is false (a kill switch stays off, so a PostHog outage does not turn the feature off)
//   closed — the value is true (a disable_* switch stays pulled until PostHog returns false)
//
// The kill switches below are `open` (a disable_* flag stays false, so the feature stays available).
// `closed` keeps a disable_* flag true until PostHog returns false. An explicit boolean and any env
// override win over that default.

import { analyticsConfig } from "./analytics";

/** What a flag is worth when PostHog has not given a boolean. */
export type UnknownPolicy = "open" | "closed";

/** Boolean flags this Worker knows. The key is the PostHog flag key, exactly. */
export const FLAGS = {
  disable_voice: {
    env: "FLAG_DISABLE_VOICE",
    onUnknown: "open" as UnknownPolicy,
    summary: "Kill switch for Talk. Not wired: voice transport is unchanged in this slice.",
  },
  disable_host_runs: {
    env: "FLAG_DISABLE_HOST_RUNS",
    onUnknown: "open" as UnknownPolicy,
    summary: "Kill switch for new host runs. Defined for a later slice; nothing calls it yet.",
  },
  disable_github_outbound: {
    env: "FLAG_DISABLE_GITHUB_OUTBOUND",
    onUnknown: "open" as UnknownPolicy,
    summary: "Kill switch for GitHub Check / comment posts. Defined for a later slice; nothing calls it yet.",
  },
  disable_north_star: {
    env: "FLAG_DISABLE_NORTH_STAR",
    onUnknown: "open" as UnknownPolicy,
    summary: "Skips the Monday north-star board post. Wired in src/northStar.ts. The weekly snapshot still runs.",
  },
} as const;

export type FlagName = keyof typeof FLAGS;
export type FlagEnvName = (typeof FLAGS)[FlagName]["env"];

/** Worker vars the helper reads. Env satisfies this. */
export interface FlagEnv {
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  FLAG_DISABLE_VOICE?: string;
  FLAG_DISABLE_HOST_RUNS?: string;
  FLAG_DISABLE_GITHUB_OUTBOUND?: string;
  FLAG_DISABLE_NORTH_STAR?: string;
}

/** One synthetic id for every server lookup. Never a person's handle, email, or board id. */
export const SERVER_DISTINCT_ID = "atteo-server";

/** How long a lookup (including a failure) is reused inside one isolate. */
export const FLAG_CACHE_MS = 60_000;

/** Remote lookup gives up after this and uses the flag's unknown policy. */
export const FLAG_TIMEOUT_MS = 1_500;

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

export interface FlagDecisionInput {
  /** Env var, if it was a recognized token. Null means "no override". */
  override: boolean | null;
  /** PostHog's boolean, if the payload named this flag. Null means "unknown". */
  remote: boolean | null;
}

/**
 * Env override, then an explicit remote boolean, then the flag's unknown policy.
 * `open` → false. `closed` → true.
 */
export function decideFlag(onUnknown: UnknownPolicy, input: FlagDecisionInput): boolean {
  if (input.override !== null) return input.override;
  if (input.remote !== null) return input.remote;
  return onUnknown === "closed";
}

/** "1" / "true" / "on" / "yes" → true; "0" / "false" / "off" / "no" → false; anything else is not an override. */
export function flagEnvOverride(raw: string | undefined): boolean | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (ON.has(s)) return true;
  if (OFF.has(s)) return false;
  return null;
}

interface CacheEntry {
  key: string;
  host: string;
  at: number;
  /** Null when the lookup failed. A map misses a flag that PostHog did not return. */
  values: Record<string, boolean> | null;
}

let cache: CacheEntry | null = null;

/** Tests start from an empty cache. Production isolates forget it when they go away. */
export function resetFlagCache(): void {
  cache = null;
}

type FlagFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface FlagReadOpts {
  fetch?: FlagFetch;
  now?: number;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Booleans from a flags v2 body, or the older featureFlags map. Null when the body is not a usable evaluation. */
export function parseFlagBody(body: unknown): Record<string, boolean> | null {
  const o = asObj(body);
  if (!o) return null;
  // A partial compute is not a trustworthy off. Callers then use the flag's unknown policy.
  if (o.errorsWhileComputingFlags === true) return null;
  const flags = asObj(o.flags);
  if (flags) {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(flags)) {
      const row = asObj(v);
      if (row && typeof row.enabled === "boolean") out[k] = row.enabled;
      else if (typeof v === "boolean") out[k] = v;
    }
    return out;
  }
  const legacy = asObj(o.featureFlags);
  if (!legacy) return null;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(legacy)) if (typeof v === "boolean") out[k] = v;
  return out;
}

async function loadRemote(env: FlagEnv, opts: FlagReadOpts): Promise<Record<string, boolean> | null> {
  const cfg = analyticsConfig(env);
  if (!cfg) return null;
  const now = opts.now ?? Date.now();
  if (cache && cache.key === cfg.key && cache.host === cfg.host && now - cache.at < FLAG_CACHE_MS && now >= cache.at) return cache.values;
  const fetchImpl = opts.fetch ?? fetch;
  let values: Record<string, boolean> | null = null;
  try {
    const res = await fetchImpl(`${cfg.host}/flags?v=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: cfg.key, distinct_id: SERVER_DISTINCT_ID }),
      signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
    });
    if (res.ok) values = parseFlagBody(await res.json());
  } catch {
    values = null;
  }
  cache = { key: cfg.key, host: cfg.host, at: now, values };
  return values;
}

/**
 * True when the named flag is on. The env var wins and skips the network. No key, a refused host, a failed
 * lookup, or a flag PostHog did not return: the flag's `onUnknown` policy (every flag shipped here is open,
 * so the switch stays off). Never throws.
 */
export async function flagOn(name: FlagName, env: FlagEnv, opts: FlagReadOpts = {}): Promise<boolean> {
  const def = FLAGS[name];
  try {
    const override = flagEnvOverride(env[def.env]);
    if (override !== null) return override;
    const values = await loadRemote(env, opts);
    const remote = values != null && typeof values[name] === "boolean" ? values[name] : null;
    return decideFlag(def.onUnknown, { override: null, remote });
  } catch {
    return decideFlag(def.onUnknown, { override: null, remote: null });
  }
}
