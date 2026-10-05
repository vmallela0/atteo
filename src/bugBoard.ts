// The developers' bug board (the BUGS_BOARD var) and the one bot member that posts every report there (opus-d #3416).
// Provisioned on first use instead of by hand (jxn #4139): the "bugs" user row (no email, no WorkOS id, so nobody can
// sign in as it), its membership of the board, and its place in the board's own member list. Feedback (vedu #4125)
// lands through the same helper.

import * as registry from "./registry";
import { BUG_BOT } from "./bugs";
import type { Env } from "./types";

/** Handles people can never take: the bot's name would let a person speak as every bug report. */
export const RESERVED_USERS: ReadonlySet<string> = new Set([BUG_BOT]);
export const isReservedUser = (name: string) => RESERVED_USERS.has(name);

// Once per isolate per board: a report after the first costs no extra queries.
const ready = new Set<string>();

/** Test hook: forget what this isolate already set up. */
export function resetBugBoardCache() {
  ready.clear();
}

/**
 * Makes `boardId` ready to take reports from the bot. Idempotent. A board that doesn't exist yet (a fresh local
 * server pointed at the prod id) is created, owned by the bot. Throws if a real person already holds the bot's name.
 */
export async function ensureBugBoard(env: Env, boardId: string, stub: DurableObjectStub & { init(id: string, title: string, createdBy: string): Promise<unknown>; join(user: string): Promise<unknown> }): Promise<void> {
  if (ready.has(boardId)) return;
  const bot = await registry.userByName(env, BUG_BOT);
  if (!bot) {
    await registry.createUser(env, { name: BUG_BOT, email: null, workos_id: null, display_name: "Bug reports" }).catch(async (e) => {
      if (!(await registry.userByName(env, BUG_BOT))) throw e; // a race with another isolate is fine
    });
  } else if (bot.email || bot.workos_id) {
    throw new Error(`The bug bot's name "${BUG_BOT}" belongs to a person; bug reports are off until ops renames it.`);
  }
  if (!(await registry.getBoard(env, boardId))) {
    const info = (await stub.init(boardId, "Atteo bugs", BUG_BOT)) as { id: string; title: string; created_by: string; created_at: number };
    await registry.recordBoard(env, info);
    await registry.addMember(env, boardId, BUG_BOT, { role: "owner" });
  } else {
    await registry.addMember(env, boardId, BUG_BOT, { role: "contributor", added_by: "system" });
  }
  await stub.join(BUG_BOT);
  ready.add(boardId);
}
