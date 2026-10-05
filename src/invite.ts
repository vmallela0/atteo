// Board invites. Nobody is added without answering: invitations wait until the invitee accepts them
// (on the web, or by asking their agent to join). New people get a sign-up email from WorkOS.

import { applies } from "./standingRules";
import { isFriend, rulesOf } from "./social";
import { sendWorkosInvitation } from "./auth";
import * as registry from "./registry";
import type { Env } from "./types";

export interface InviteResult {
  ok: boolean;
  added: boolean; // reserved: invitations always wait for the invitee to accept
  emailed: boolean;
  signInUrl: string;
  message: string;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function sendInvite(
  env: Env,
  origin: string,
  opts: { boardId: string; email: string; invitedBy: string; role?: import("./registry").Role; expiresDays?: number | null },
): Promise<InviteResult> {
  const email = opts.email.trim().toLowerCase();
  const board = await registry.getBoard(env, opts.boardId);
  const signInUrl = `${origin}/auth/login?login_hint=${encodeURIComponent(email)}`;
  const base = { id: crypto.randomUUID(), board_id: opts.boardId, email, invited_by: opts.invitedBy, created_at: Date.now(), role: opts.role ?? "contributor", expires_days: opts.expiresDays ?? null };
  // "Your agent" is between a person and their own agents: no one else is ever invited.
  if ((board as { kind?: string | null } | null)?.kind === "agent") return { ok: false, added: false, emailed: false, signInUrl, message: `Board ${opts.boardId} is your private chat with your own agents; no one else can join it.` };

  const existing = await registry.userByEmail(env, email);
  if (existing && (await registry.isMember(env, opts.boardId, existing.name))) {
    return { ok: true, added: false, emailed: false, signInUrl, message: `${existing.name} (${email}) is already a member of board ${opts.boardId}.` };
  }
  if (await registry.hasOpenInvite(env, opts.boardId, email)) {
    return { ok: true, added: false, emailed: false, signInUrl, message: `${email} already has an open invitation to board ${opts.boardId}.` };
  }
  if (existing) {
    // Account-wide: invites from friends join them right away. A standing rule does the same for one person or
    // for current members of one board, until it expires.
    const byFriend = opts.invitedBy !== "ops" && (await rulesOf(env, existing.name)).auto_accept_invites === "friends" && (await isFriend(env, opts.invitedBy, existing.name));
    const byStanding = opts.invitedBy !== "ops" && (await applies(env, existing.name, "accept_invites", opts.invitedBy));
    if (byFriend || byStanding) {
      await registry.recordInvite(env, { ...base, email_status: byFriend ? "accepted by their rule (invites from friends)" : "accepted by their standing rule" });
      if (await registry.acceptInvitation(env, existing, opts.boardId, origin).catch(() => false)) {
        return {
          ok: true,
          added: true,
          emailed: false,
          signInUrl,
          message: byFriend
            ? `${existing.name} joined board ${opts.boardId} right away (they accept invites from friends automatically).`
            : `${existing.name} joined board ${opts.boardId} right away (a standing rule of theirs).`,
        };
      }
    }
    // Has an account: no email needed. The invitation waits in their Atteo until they accept it.
    await registry.recordInvite(env, { ...base, email_status: "pending: has an account" });
    return {
      ok: true,
      added: false,
      emailed: false,
      signInUrl,
      message: `Invited ${existing.name} (${email}) to board ${opts.boardId}. They already have an account, so they'll see the invitation in Atteo and can accept it there, or by asking their agent to join board ${opts.boardId}.`,
    };
  }

  const inviter = await registry.userByName(env, opts.invitedBy);
  const sent = await sendWorkosInvitation(env, email, inviter?.workos_id ?? null);
  await registry.recordInvite(env, {
    ...base,
    email_status: sent.ok ? "emailed by WorkOS" : `not emailed: ${sent.error}`,
    workos_invitation_id: sent.ok ? sent.id : null,
  });

  return {
    ok: true,
    added: false,
    emailed: sent.ok,
    signInUrl,
    message: sent.ok
      ? `Invited ${email} to board ${opts.boardId}. WorkOS is emailing them a sign-up link; after signing up with that email they can accept the invitation.`
      : `Saved an invitation for ${email} to board ${opts.boardId}, but the email didn't go out (${sent.error}). Send them this link; after signing in with that email they can accept it: ${signInUrl}`,
  };
}
