// /_ops secret presence is set/missing only. A secret value must not appear in the flags or the page.
import { describe, expect, it } from "vitest";
import { adminPage } from "../src/html";
import { SECRET_PRESENCE_KEYS, secretIsSet, secretPresence, type SecretPresenceKey } from "../src/secretPresence";
import type { Env } from "../src/types";

const MARK = "LEAK9f3aSECRETS";

const empty = { boards: [], users: [], invites: [], recent: [], totalEntries: 0, access: [] };
const viewer = { name: "vedu", email: "vedu@example.com", display_name: null, admin: true };

function envWithSecrets(): Partial<Env> {
  const env: Partial<Env> = {};
  for (const name of SECRET_PRESENCE_KEYS) env[name] = `prefix-${MARK}-${name}-suffix`;
  env.STRIPE_SECRET_KEY = "   ";
  env.APNS_KEY = "";
  env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN ${MARK}-----\nline\n-----END ${MARK}-----`;
  return env;
}

describe("secret presence", () => {
  it("returns only name and a boolean, never the value", () => {
    const flags = secretPresence(envWithSecrets());
    const encoded = JSON.stringify(flags);
    expect(encoded).not.toContain(MARK);
    expect(encoded).not.toContain("prefix-");
    expect(encoded).not.toContain("BEGIN");
    expect(flags.map((r) => r.name)).toEqual([...SECRET_PRESENCE_KEYS]);
    for (const row of flags) {
      expect(Object.keys(row).sort()).toEqual(["name", "set"]);
      expect(row.set === true || row.set === false).toBe(true);
    }
    const byName = new Map(flags.map((r) => [r.name, r.set]));
    expect(byName.get("WORKOS_API_KEY")).toBe(true);
    expect(byName.get("ADMIN_KEY")).toBe(true);
    expect(byName.get("STRIPE_SECRET_KEY")).toBe(false);
    expect(byName.get("APNS_KEY")).toBe(false);
    expect(byName.get("GITHUB_APP_PRIVATE_KEY")).toBe(true);
    expect(byName.get("POSTHOG_KEY")).toBe(true);
  });

  it("treats non-strings as missing", () => {
    expect(secretIsSet(undefined)).toBe(false);
    expect(secretIsSet(null)).toBe(false);
    expect(secretIsSet(1)).toBe(false);
    expect(secretIsSet("  ")).toBe(false);
    expect(secretIsSet("x")).toBe(true);
    const flags = secretPresence({ AI_TOKEN: 1 as unknown as string, SENTRY_DSN: null as unknown as string });
    expect(flags.find((r) => r.name === "AI_TOKEN")?.set).toBe(false);
    expect(flags.find((r) => r.name === "SENTRY_DSN")?.set).toBe(false);
  });

  it("renders set or missing on /_ops and does not echo secret substrings", async () => {
    const flags = secretPresence(envWithSecrets());
    const html = await adminPage(viewer, [], { ...empty, secrets: flags }).text();
    expect(html).not.toContain(MARK);
    expect(html).not.toContain("prefix-");
    expect(html).not.toContain("BEGIN");
    expect(html).toContain('data-secret-presence');
    expect(html).toContain("docs/SECRETS.md");
    expect(html).toContain('data-secret="WORKOS_API_KEY"');
    expect(html).toContain('data-secret="STRIPE_SECRET_KEY"');
    expect(html).toContain('data-secret="GITHUB_APP_PRIVATE_KEY"');
    const cell = (name: SecretPresenceKey) => html.match(new RegExp(`data-secret="${name}"[\\s\\S]*?<td>(set|missing)</td>`))?.[1];
    expect(cell("WORKOS_API_KEY")).toBe("set");
    expect(cell("STRIPE_SECRET_KEY")).toBe("missing");
    expect(cell("APNS_KEY")).toBe("missing");
    expect(cell("GITHUB_APP_PRIVATE_KEY")).toBe("set");
    expect(cell("POSTHOG_KEY")).toBe("set");
  });

  it("does not print a non-boolean set field", async () => {
    const html = await adminPage(viewer, [], {
      ...empty,
      secrets: [{ name: "ADMIN_KEY", set: MARK as unknown as boolean }],
    }).text();
    expect(html).not.toContain(MARK);
    expect(html).toContain('data-secret="ADMIN_KEY"');
    expect(html).toMatch(/data-secret="ADMIN_KEY"[\s\S]*?<td>missing<\/td>/);
  });

  it("omits the section when the page has no presence list", async () => {
    const html = await adminPage(viewer, [], empty).text();
    expect(html).not.toContain("data-secret-presence");
    expect(html).not.toContain(MARK);
  });
});
