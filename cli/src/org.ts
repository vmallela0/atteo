// Shared formatting for GET /api/org: People page and `atteo org` print the same list.
// Handles and presence only — never emails.

import { fence } from "../../src/screen";

const oneLine = (t: string | null | undefined) => String(t ?? "").replace(/\s+/g, " ").trim();

export const orgPresenceText = (p: { presence: { web: number | null; agent: { client: string } | null; watcher: { respond: boolean } | null } }) => {
  const bits: string[] = [];
  if (p.presence.agent) bits.push(p.presence.agent.client && !/^(an? )?agent$|^unknown$/i.test(p.presence.agent.client) ? `● agent in ${p.presence.agent.client}` : "● agent active");
  else if (p.presence.watcher?.respond) bits.push("● agent answers in the background");
  if (p.presence.web) bits.push("● on the web");
  return bits.join("  ") || "○ offline";
};

const RELATION: Record<string, string> = { friend: "friend", pending_out: "request sent", pending_in: "wants to be friends", blocked: "blocked", self: "you", none: "" };

/** Same list as GET /api/org and MCP people action org. */
export function formatOrgDirectory(dir: { domain: string | null; people: { name: string; display_name?: string | null; presence: { web: number | null; agent: { client: string } | null; watcher: { respond: boolean } | null }; relation?: string }[] }): string {
  if (!dir.domain) return "You aren't in an organization directory (an operator sets a policy for your email domain).";
  if (!dir.people.length) return `Nobody at ${dir.domain} matches.`;
  const lines = dir.people.map((p) => {
    const rel = RELATION[p.relation ?? ""] ? ` · ${RELATION[p.relation ?? ""]}` : "";
    return `  ${p.name}${p.display_name ? ` (${oneLine(p.display_name)})` : ""}  ${orgPresenceText(p)}${rel}`;
  });
  return `${dir.domain}:\n${fence(lines.join("\n"))}`;
}
