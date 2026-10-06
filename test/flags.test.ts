import { beforeEach, describe, expect, it } from "vitest";
import {
  FLAG_CACHE_MS,
  FLAGS,
  SERVER_DISTINCT_ID,
  decideFlag,
  flagEnvOverride,
  flagOn,
  parseFlagBody,
  resetFlagCache,
} from "../src/flags";

const KEY = "phc_testkey123";
const NOW = 1_700_000_000_000;

beforeEach(() => resetFlagCache());

function response(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });
}

describe("unknown policy", () => {
  it("open stays false and closed stays true until someone says otherwise", () => {
    expect(decideFlag("open", { override: null, remote: null })).toBe(false);
    expect(decideFlag("closed", { override: null, remote: null })).toBe(true);
    expect(decideFlag("closed", { override: null, remote: false })).toBe(false);
    expect(decideFlag("open", { override: true, remote: null })).toBe(true);
    expect(decideFlag("closed", { override: false, remote: true })).toBe(false);
  });

  it("every shipped flag fails open", () => {
    for (const def of Object.values(FLAGS)) expect(def.onUnknown).toBe("open");
  });
});

describe("env override tokens", () => {
  it("accepts the on and off words and ignores anything else", () => {
    expect(flagEnvOverride(" 1 ")).toBe(true);
    expect(flagEnvOverride("TRUE")).toBe(true);
    expect(flagEnvOverride("on")).toBe(true);
    expect(flagEnvOverride("yes")).toBe(true);
    expect(flagEnvOverride("0")).toBe(false);
    expect(flagEnvOverride("False")).toBe(false);
    expect(flagEnvOverride("off")).toBe(false);
    expect(flagEnvOverride("no")).toBe(false);
    expect(flagEnvOverride("")).toBeNull();
    expect(flagEnvOverride("maybe")).toBeNull();
  });
});

describe("flag lookup", () => {
  it("does not fetch when the project key is missing or is not a project key", async () => {
    const fetchImpl = async () => {
      throw new Error("should not fetch");
    };
    expect(await flagOn("disable_north_star", {}, { fetch: fetchImpl, now: NOW })).toBe(false);
    expect(await flagOn("disable_github_outbound", { POSTHOG_KEY: "  " }, { fetch: fetchImpl, now: NOW })).toBe(false);
    expect(await flagOn("disable_voice", { POSTHOG_KEY: "phx_personal_key_not_allowed" }, { fetch: fetchImpl, now: NOW })).toBe(false);
    expect(await flagOn("disable_host_runs", { POSTHOG_KEY: KEY, POSTHOG_HOST: "https://evil.example" }, { fetch: fetchImpl, now: NOW })).toBe(false);
  });

  it("uses the open default when the lookup fails, and does not throw", async () => {
    const env = { POSTHOG_KEY: KEY, POSTHOG_HOST: "us" };
    const reject = async () => Promise.reject(new Error("down"));
    expect(await flagOn("disable_north_star", env, { fetch: reject, now: NOW })).toBe(false);
    resetFlagCache();
    const http = async () => response({ error: "no" }, false);
    expect(await flagOn("disable_host_runs", env, { fetch: http, now: NOW })).toBe(false);
    resetFlagCache();
    const bad = async () => new Response("not-json", { status: 200 });
    expect(await flagOn("disable_voice", env, { fetch: bad, now: NOW })).toBe(false);
    resetFlagCache();
    const partial = async () => response({ errorsWhileComputingFlags: true, flags: { disable_github_outbound: { enabled: true } } });
    expect(await flagOn("disable_github_outbound", env, { fetch: partial, now: NOW })).toBe(false);
  });

  it("lets the env var win and skips the network, either direction", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return response({ flags: { disable_north_star: { enabled: true } } });
    };
    const base = { POSTHOG_KEY: KEY, POSTHOG_HOST: "us" };
    expect(await flagOn("disable_north_star", { ...base, FLAG_DISABLE_NORTH_STAR: "1" }, { fetch: fetchImpl, now: NOW })).toBe(true);
    expect(await flagOn("disable_north_star", { ...base, FLAG_DISABLE_NORTH_STAR: "0" }, { fetch: fetchImpl, now: NOW })).toBe(false);
    expect(calls).toBe(0);
  });

  it("posts only the project key and the server distinct id, then reads enabled", async () => {
    let url = "";
    let sent = "";
    const fetchImpl = async (u: string, init?: RequestInit) => {
      url = u;
      sent = String(init?.body ?? "");
      return response({
        flags: {
          disable_north_star: { key: "disable_north_star", enabled: true, variant: "ignore-me" },
          disable_voice: { enabled: false },
        },
      });
    };
    const env = { POSTHOG_KEY: KEY, POSTHOG_HOST: "us" };
    expect(await flagOn("disable_north_star", env, { fetch: fetchImpl, now: NOW })).toBe(true);
    expect(await flagOn("disable_voice", env, { fetch: fetchImpl, now: NOW })).toBe(false);
    expect(url).toBe("https://us.i.posthog.com/flags?v=2");
    expect(JSON.parse(sent)).toEqual({ api_key: KEY, distinct_id: SERVER_DISTINCT_ID });
    expect(sent).not.toMatch(/email|@|handle/i);
  });

  it("treats a flag PostHog did not return as unknown (open → false)", async () => {
    const fetchImpl = async () => response({ flags: {} });
    expect(await flagOn("disable_github_outbound", { POSTHOG_KEY: KEY, POSTHOG_HOST: "us" }, { fetch: fetchImpl, now: NOW })).toBe(false);
  });

  it("reuses a lookup for a minute, including a failure, then asks again", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return response({ flags: { disable_host_runs: { enabled: true } } });
      return Promise.reject(new Error("later"));
    };
    const env = { POSTHOG_KEY: KEY, POSTHOG_HOST: "eu" };
    expect(await flagOn("disable_host_runs", env, { fetch: fetchImpl, now: NOW })).toBe(true);
    expect(await flagOn("disable_host_runs", env, { fetch: fetchImpl, now: NOW + FLAG_CACHE_MS - 1 })).toBe(true);
    expect(calls).toBe(1);
    expect(await flagOn("disable_host_runs", env, { fetch: fetchImpl, now: NOW + FLAG_CACHE_MS })).toBe(false);
    expect(await flagOn("disable_host_runs", env, { fetch: fetchImpl, now: NOW + FLAG_CACHE_MS + 1 })).toBe(false);
    expect(calls).toBe(2);
  });

  it("reads the older featureFlags map of booleans and ignores variant strings", () => {
    expect(parseFlagBody({ featureFlags: { disable_voice: true, disable_host_runs: "control" } })).toEqual({ disable_voice: true });
    expect(parseFlagBody(null)).toBeNull();
    expect(parseFlagBody({ flags: { disable_voice: { enabled: "yes" } } })).toEqual({});
  });
});
