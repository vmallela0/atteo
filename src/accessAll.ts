// Access across your boards (#3568; GAPS P0 network #6, "one page listing every grant across boards, and review nudges"):
// every board you're on with your role and end date; on the boards you own, everyone else's access, the invite links
// still open and the invitations not yet accepted. Nudges point at what's worth a look: access with no end date held
// for REVIEW_DAYS or more, and links that never stop working. People only (an agent's token is refused at the route).
// Removing and revoking go through the boards' own routes, which check ownership again.

import { userByEmail } from "./registry";
import type { Env } from "./types";

/** Access with no end date this old (days) gets a "review" nudge. */
export const REVIEW_DAYS = 90;
const DAY = 86_400_000;

export interface AccessBoard {
  id: string;
  title: string;
  role: string; // yours
  expires_at: number | null; // your access ends then
  owner: boolean;
  archived: boolean;
  members?: { user: string; role: string; expires_at: number | null; joined_at: number; added_by: string | null; review: boolean }[];
  links?: { id: string; role: string; member_days: number | null; created_at: number; expires_at: number | null; uses: number; max_uses: number | null; review: boolean }[];
  invites?: { id: string; who: string; role: string; created_at: number }[];
}

type Row = Record<string, unknown>;

/** The boards this person is on (direct boards and their own agents' chat aside), newest activity first. */
export const MY_BOARDS_SQL = `SELECT b.id, b.title, b.created_by, b.archived_at, m.role, m.expires_at FROM members m JOIN boards b ON b.id = m.board_id
  WHERE m.user = ? AND b.deleted_at IS NULL AND b.kind IS NULL AND (m.expires_at IS NULL OR m.expires_at > ?) ORDER BY b.last_activity DESC LIMIT 500`;

export type AccessAll = { boards: AccessBoard[]; review_days: number; nudges: number };

export async function accessAll(env: Env, user: string, now = Date.now()): Promise<AccessAll> {
  const mine = (await env.DB.prepare(MY_BOARDS_SQL).bind(user, now).all<Row>()).results;
  const boards: AccessBoard[] = mine.map((b) => ({
    id: b.id as string,
    title: b.title as string,
    role: b.role as string,
    expires_at: (b.expires_at as number | null) ?? null,
    owner: b.role === "owner" || b.created_by === user,
    archived: b.archived_at != null,
  }));
  const owned = boards.filter((b) => b.owner).map((b) => b.id);
  let nudges = 0;
  if (owned.length) {
    const ids = JSON.stringify(owned);
    const [members, links, invites] = await Promise.all([
      env.DB.prepare(`SELECT board_id, user, role, expires_at, joined_at, added_by FROM members WHERE board_id IN (SELECT value FROM json_each(?)) AND user != ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY joined_at`).bind(ids, user, now).all<Row>(),
      env.DB.prepare(`SELECT id, board_id, role, member_days, created_at, expires_at, uses, max_uses FROM invite_links WHERE board_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses) ORDER BY created_at`).bind(ids, now).all<Row>(),
      env.DB.prepare(`SELECT id, board_id, email, role, created_at FROM invites WHERE board_id IN (SELECT value FROM json_each(?)) AND accepted_at IS NULL ORDER BY created_at`).bind(ids).all<Row>(),
    ]);
    // An invitation names its person when the address is a member of Atteo's (as the board's own dialog does), else the address.
    const named = await Promise.all(invites.results.map(async (i) => (await userByEmail(env, i.email as string))?.name ?? null));
    const by = new Map(boards.map((b) => [b.id, b]));
    for (const b of owned) Object.assign(by.get(b)!, { members: [], links: [], invites: [] });
    for (const m of members.results) {
      const review = m.expires_at == null && m.role !== "owner" && now - (m.joined_at as number) >= REVIEW_DAYS * DAY;
      if (review) nudges++;
      by.get(m.board_id as string)!.members!.push({ user: m.user as string, role: m.role as string, expires_at: (m.expires_at as number | null) ?? null, joined_at: m.joined_at as number, added_by: (m.added_by as string | null) ?? null, review });
    }
    for (const l of links.results) {
      const review = l.expires_at == null; // a link that never stops working
      if (review) nudges++;
      by.get(l.board_id as string)!.links!.push({ id: l.id as string, role: l.role as string, member_days: (l.member_days as number | null) ?? null, created_at: l.created_at as number, expires_at: (l.expires_at as number | null) ?? null, uses: l.uses as number, max_uses: (l.max_uses as number | null) ?? null, review });
    }
    invites.results.forEach((i, k) => by.get(i.board_id as string)!.invites!.push({ id: i.id as string, who: named[k] ?? (i.email as string), role: i.role as string, created_at: i.created_at as number }));
  }
  return { boards, review_days: REVIEW_DAYS, nudges };
}
