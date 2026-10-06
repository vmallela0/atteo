// People-page and CLI surfaces for the org directory (GET /api/org).
// Happy path + directory-off / no-org; handles and presence only, never emails.

import { describe, expect, it } from "vitest";
import { peoplePage } from "../src/html";
import { formatOrgDirectory } from "../cli/src/org";
import type { Person } from "../src/social";
import type { Viewer } from "../src/ui";

const viewer: Viewer = { name: "ada", email: "ada@acme.com", display_name: "Ada", admin: false, lang: "en" };
const emptyFriends = { friends: [], incoming: [], outgoing: [], blocked: [] };
const offline = { web: null, agent: null, watcher: null };

function mate(name: string, extra: Partial<Person> = {}): Person {
  return {
    name,
    display_name: extra.display_name ?? null,
    agent_name: extra.agent_name ?? null,
    bio: extra.bio ?? null,
    relation: extra.relation ?? "none",
    presence: extra.presence ?? offline,
    shared_boards: extra.shared_boards ?? 0,
  };
}

async function render(org?: { domain: string | null; people: Person[] }) {
  const html = await peoplePage(viewer, [], emptyFriends as never, org).text();
  for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
  return html;
}

function orgChunk(html: string) {
  const m = html.match(/<div id="org">([\s\S]*?)<\/div>\s*<p class="xs faint ppl-note">/);
  expect(m, "Organization section").toBeTruthy();
  return m![1];
}

describe("People page: organization directory", () => {
  it("no-org and directory-off look the same: a clear empty state, no list, no emails", async () => {
    const omitted = await render();
    const explicit = await render({ domain: null, people: [] });
    for (const html of [omitted, explicit]) {
      const org = orgChunk(html);
      expect(org).toContain("not in an organization directory");
      expect(org).toContain("id=\"org-empty\"");
      expect(org).not.toContain("id=\"org-list\"");
      expect(org).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(html).toContain("atteo org");
    }
  });

  it("directory on with nobody else: names the domain, still no emails", async () => {
    const html = await render({ domain: "acme.com", people: [] });
    const org = orgChunk(html);
    expect(org).toContain("Nobody at acme.com is on Atteo yet.");
    expect(org).toContain("People at acme.com");
    expect(org).toContain("never emails");
    expect(org).not.toContain("@acme.com");
    expect(org).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("lists org-mates with handles and presence, never emails", async () => {
    const html = await render({
      domain: "acme.com",
      people: [
        mate("ada", { display_name: "Ada", relation: "self", presence: { web: Date.now(), agent: null, watcher: null } }),
        mate("bea", { display_name: "Bea", presence: { web: null, agent: { client: "Cursor", seen: Date.now() }, watcher: null } }),
      ],
    });
    const org = orgChunk(html);
    expect(org).toContain("id=\"org-list\"");
    expect(org).toContain(">Ada</span>");
    expect(org).toContain("@ada");
    expect(org).toContain(">Bea</span>");
    expect(org).toContain("@bea");
    expect(org).toContain("Online");
    expect(org).toContain("Agent in Cursor");
    expect(org).toContain("People at acme.com");
    expect(org).not.toContain("ada@acme.com");
    expect(org).not.toContain("bea@acme.com");
    expect(org).not.toContain("@acme.com");
    expect(org).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

describe("atteo org", () => {
  it("no-org / directory-off: the same clear sentence, no emails", () => {
    const out = formatOrgDirectory({ domain: null, people: [] });
    expect(out).toBe("You aren't in an organization directory (an operator sets a policy for your email domain).");
    expect(out).not.toMatch(/@/);
  });

  it("directory on, nobody matches", () => {
    const out = formatOrgDirectory({ domain: "acme.com", people: [] });
    expect(out).toBe("Nobody at acme.com matches.");
    expect(out).not.toContain("@");
  });

  it("happy path: domain, handles, presence; display names fenced; never emails", () => {
    const out = formatOrgDirectory({
      domain: "acme.com",
      people: [
        { name: "ada", display_name: "Ada", presence: { web: 1, agent: null, watcher: null }, relation: "self" },
        { name: "bea", display_name: "Bea", presence: { web: null, agent: { client: "Cursor" }, watcher: null }, relation: "none" },
      ],
    });
    expect(out.startsWith("acme.com:\n")).toBe(true);
    expect(out).toContain("ada");
    expect(out).toContain("● on the web");
    expect(out).toContain("· you");
    expect(out).toContain("bea");
    expect(out).toContain("● agent in Cursor");
    expect(out).toMatch(/<<untrusted [0-9a-f]+:/);
    expect(out).toContain("Ada");
    expect(out).not.toMatch(/ada@acme\.com|bea@acme\.com/);
  });
});
