// Organization policies that apply when someone joins a board: a domain can keep its boards to its own people.

import type { Env } from "./types";

export async function checkOutsideMember(env: Env, boardId: string, joinerEmail: string | null): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT u.email AS creator_email, p.domain, p.allow_outside_members FROM boards b JOIN users u ON u.name = b.created_by
     LEFT JOIN org_policies p ON p.domain = lower(substr(u.email, instr(u.email, '@') + 1)) WHERE b.id = ?`,
  )
    .bind(boardId)
    .first<{ creator_email: string | null; domain: string | null; allow_outside_members: number | null }>();
  if (!r?.domain || r.allow_outside_members !== 0) return;
  const joinerDomain = (joinerEmail ?? "").split("@")[1]?.toLowerCase();
  if (joinerDomain !== r.domain) throw new Error(`Boards created at ${r.domain} are for ${r.domain} accounts only (organization policy).`);
}
