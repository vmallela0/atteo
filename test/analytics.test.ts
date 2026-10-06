import { describe, expect, it } from "vitest";
import {
  ANALYTICS_EVENTS,
  analyticsBoot,
  analyticsConfig,
  captureBody,
  PROP_KEYS,
  sanitizeProps,
  posthogDashboardUrl,
  trackCookieHeader,
  withAnalytics,
} from "../src/analytics";
import { adminPage, boardPage, legalPage } from "../src/html";
import { page } from "../src/ui";
import { beaconSnippet } from "../landing/src/csp";

const viewer = { name: "ada", email: "ada@example.com", display_name: null, admin: true };
const KEY = "phc_testkey123";

describe("analytics config", () => {
  it("is off without a project key", () => {
    expect(analyticsConfig({})).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY: "  " })).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY: "phx_not_a_project_key" })).toBeNull();
    expect(analyticsBoot(null)).toBe("");
  });

  it("defaults to the EU ingest host and accepts us", () => {
    expect(analyticsConfig({ POSTHOG_KEY: KEY })).toEqual({ key: KEY, host: "https://eu.i.posthog.com", region: "eu" });
    expect(analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "US" })?.host).toBe("https://us.i.posthog.com");
    expect(analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "https://eu.i.posthog.com/" })?.region).toBe("eu");
  });

  it("refuses any other host, so the key cannot be sent elsewhere", () => {
    expect(analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "https://evil.example" })).toBeNull();
    expect(analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "eu.i.posthog.com.evil.example" })).toBeNull();
  });
});

describe("capture payload", () => {
  const cfg = analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "eu" })!;

  it("keeps allowlisted tokens and drops emails, message text, and unknown keys", () => {
    expect(sanitizeProps({ surface: "talk", email: "ada@example.com", text: "hello board", role: "Viewer", extra: "x" })).toEqual({ surface: "talk" });
    expect(sanitizeProps(null)).toEqual({});
    expect(sanitizeProps({ interval: "month" })).toEqual({ interval: "month" });
  });

  it("builds a capture body only for planned events and an anonymous id", () => {
    const body = captureBody(cfg, "sign_up", "11111111-2222-4333-8444-555555555555", { email: "ada@example.com", surface: "web" }, new Date("2026-10-06T00:00:00.000Z"));
    expect(body).toEqual({
      api_key: KEY,
      event: "sign_up",
      distinct_id: "11111111-2222-4333-8444-555555555555",
      properties: { $lib: "atteo-web", surface: "web" },
      timestamp: "2026-10-06T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("ada@example.com");
    expect(captureBody(cfg, "password_reset", "11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(captureBody(cfg, "sign_in", "ada@example.com")).toBeNull();
  });

  it("sets a short cookie that is only the event name", () => {
    const secure = trackCookieHeader(new URL("https://atteo.dev/welcome"), "sign_up");
    expect(secure).toContain("ab_track=sign_up");
    expect(secure).toContain("Secure");
    expect(secure).not.toContain("HttpOnly");
    expect(secure).not.toContain("@");
    expect(trackCookieHeader(new URL("http://127.0.0.1/"), "board_created")).not.toContain("Secure");
  });
});

describe("web loader", () => {
  const cfg = analyticsConfig({ POSTHOG_KEY: KEY, POSTHOG_HOST: "eu" })!;

  it("posts only to the configured host, honors Do Not Track, and shares the server allowlists", () => {
    const js = analyticsBoot(cfg);
    expect(js).toContain(JSON.stringify(ANALYTICS_EVENTS));
    expect(js).toContain(JSON.stringify(PROP_KEYS));
    expect(js).toContain('HOST="https://eu.i.posthog.com"');
    expect(js).toContain('HOST+"/capture/"');
    expect(js).toContain("doNotTrack");
    expect(js).toContain("globalPrivacyControl");
    expect(js).not.toMatch(/email|@example/);
    expect(js).not.toContain("</script>");
    expect(() => new Function(js)).not.toThrow();
  });

  it("leaves pages and connect-src alone until a key is set, then adds the ingest host", async () => {
    const off = page("Hi", "<p>x</p>");
    const offHtml = await off.text();
    expect(offHtml).not.toContain("posthog");
    expect(offHtml).not.toContain("atteoTrack");
    const offCsp = off.headers.get("content-security-policy-report-only") ?? "";
    expect(offCsp).not.toContain("posthog");
    expect(offCsp).toContain("connect-src 'self' wss://api.x.ai");

    const on = await withAnalytics({ POSTHOG_KEY: KEY, POSTHOG_HOST: "us" }, async () => {
      const res = page("Hi", "<p>x</p>");
      return { html: await res.text(), csp: res.headers.get("content-security-policy-report-only") ?? "" };
    });
    expect(on.html).toContain('HOST="https://us.i.posthog.com"');
    expect(on.html).toContain('HOST+"/capture/"');
    expect(on.html).toContain(KEY);
    expect(on.csp).toContain("connect-src 'self' wss://api.x.ai https://us.i.posthog.com");
    expect(on.csp.split("; ").find((d) => d.startsWith("script-src "))).not.toMatch(/https?:/);
  });

  it("links the dashboard from ops only when the key is set", async () => {
    const data = { boards: [], users: [], invites: [], recent: [], totalEntries: 0, access: [] };
    const off = await adminPage(viewer, [], data).text();
    expect(off).toContain("docs/ANALYTICS.md");
    expect(off).toContain("POSTHOG_KEY");
    expect(off).not.toContain("posthog.com");

    const eu = await withAnalytics({ POSTHOG_KEY: KEY }, async () => adminPage(viewer, [], data).text());
    expect(eu).toContain('href="https://eu.posthog.com"');
    expect(eu).toContain("eu.i.posthog.com");

    const us = await withAnalytics({ POSTHOG_KEY: KEY, POSTHOG_HOST: "us" }, async () => adminPage(viewer, [], data).text());
    expect(us).toContain('href="https://us.posthog.com/project/647810"');
    expect(posthogDashboardUrl({ key: KEY, host: "https://us.i.posthog.com", region: "us" })).toBe("https://us.posthog.com/project/647810");
  });
});

describe("privacy", () => {
  it("names PostHog as product analytics that stays off without a key", async () => {
    const html = await legalPage("privacy").text();
    expect(html).toContain("<b>PostHog</b>");
    expect(html).toContain("product analytics");
    expect(html).toContain("message text");
    expect(html).toContain("email addresses");
    expect(html).toContain("Do Not Track");
    expect(html).toContain("Global Privacy Control");
    expect(html).toContain("With no key set, nothing is sent.");
    expect(html).toContain("Last updated October 6, 2026.");
    expect(html).not.toContain("phc_");
    const terms = await legalPage("terms").text();
    expect(terms).not.toContain("PostHog");
  });
});

describe("event hooks", () => {
  it("fires the planned events from existing client paths and never forwards a message", async () => {
    const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: "utf8") => string };
    const html = readFileSync("src/html.ts", "utf8");
    const talk = readFileSync("src/talk.ts", "utf8");
    const e2e = readFileSync("src/e2eweb.ts", "utf8");
    expect(html).toContain('data-track="invite_sent"');
    expect(html).toContain("atteoTrack('first_message')");
    expect(html).toContain("atteoTrack('agent_posted')");
    expect(html).toContain("atteoTrack('agent_connected')");
    expect(html).toContain("atteoTrack('invite_accepted')");
    expect(html).toContain("atteoTrack('pro_started')");
    expect(html).toContain("atteoTrack('voice_used',{surface:'dictate'})");
    expect(talk).toContain("atteoTrack('voice_used',{surface:'talk'})");
    expect(e2e).toContain("atteoTrack('first_message')");
    expect(html + talk + e2e).not.toContain("atteoTrack('voice_used',{text");
    expect(html).not.toContain("atteoTrack(ta.value");
  });

  it("does not put the loader on a board page rendered without a key", async () => {
    const res = boardPage(viewer, [], { id: "b_ada", title: "Ada", created_by: "ada", created_at: 0, entry_count: 0, last_seq: 0 }, [], [], []);
    expect(await res.text()).not.toContain("posthog");
  });
});

describe("Cloudflare Web Analytics beacon", () => {
  it("is empty unless the token is a token", () => {
    expect(beaconSnippet(undefined)).toBe("");
    expect(beaconSnippet("short")).toBe("");
    expect(beaconSnippet("bad token!")).toBe("");
    const tag = beaconSnippet("abcdef0123456789");
    expect(tag).toContain("https://static.cloudflareinsights.com/beacon.min.js");
    expect(tag).toContain('"token":"abcdef0123456789"');
    expect(tag).not.toContain("<script>");
  });
});
