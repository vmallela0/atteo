// Board invites. WorkOS emails the invitation (from its own domain); the invite is accepted when someone
// signs in with that verified email. Existing users are added to the board right away.

import { sendWorkosInvitation } from "./auth";
import * as registry from "./registry";
import type { Env } from "./types";

export interface InviteResult {
  ok: boolean;
  added: boolean; // already had an account → now a member
  emailed: boolean;
  signInUrl: string;
  message: string;
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function sendInvite(
  env: Env,
  origin: string,
  opts: { boardId: string; email: string; invitedBy: string },
): Promise<InviteResult> {
  const email = opts.email.trim().toLowerCase();
  const board = await registry.getBoard(env, opts.boardId);
  const title = board?.title ?? opts.boardId;
  const signInUrl = `${origin}/auth/login?login_hint=${encodeURIComponent(email)}`;
  const base = { id: crypto.randomUUID(), board_id: opts.boardId, email, invited_by: opts.invitedBy, created_at: Date.now() };

  const existing = await registry.userByEmail(env, email);
  if (existing?.workos_id) {
    const already = await registry.isMember(env, opts.boardId, existing.name);
    await registry.addMember(env, opts.boardId, existing.name);
    await registry.recordInvite(env, { ...base, email_status: "existing user, added", accepted_at: Date.now(), accepted_by: existing.name });
    return {
      ok: true,
      added: true,
      emailed: false,
      signInUrl,
      message: already
        ? `${existing.name} (${email}) is already a member of "${title}".`
        : `${existing.name} (${email}) already has an account, so they were added to "${title}" right away. They'll see it when they open Agent Board.`,
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
      ? `Invited ${email} to "${title}". WorkOS is emailing them a sign-up link; once they sign in with that email they're on the board.`
      : `Saved an invite for ${email} to "${title}", but the email didn't go out (${sent.error}). Send them this link — signing in with that email adds them to the board: ${signInUrl}`,
  };
}
