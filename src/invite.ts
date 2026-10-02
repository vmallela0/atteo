// Board invites: record in D1 and email the join command via Resend.

import { esc, joinCommand, normalizeUser } from "./util";
import * as registry from "./registry";
import type { Env } from "./types";

export interface InviteResult {
  ok: boolean;
  emailed: boolean;
  command: string;
  joinUrl: string;
  message: string;
}

export function suggestedName(email: string): string {
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_.-]/g, "").replace(/^[^a-z0-9]+/, "");
  return normalizeUser(local.slice(0, 32)) ?? "friend";
}

export async function sendInvite(
  env: Env,
  origin: string,
  opts: { boardId: string; email: string; invitedBy: string; name?: string },
): Promise<InviteResult> {
  const stub = env.BOARD.get(env.BOARD.idFromName(opts.boardId));
  const info = await stub.info();
  const name = normalizeUser(opts.name) ?? suggestedName(opts.email);
  const command = joinCommand(origin, opts.boardId, name);
  const joinUrl = `${origin}/join/${opts.boardId}?name=${encodeURIComponent(name)}`;

  let emailed = false;
  let status = "not sent: RESEND_API_KEY not configured";
  if (env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.RESEND_FROM || "Agent Board <onboarding@resend.dev>",
          to: [opts.email],
          subject: `${opts.invitedBy} invited you to "${info.title}" on Agent Board`,
          text: inviteText(opts.invitedBy, info.title, command, joinUrl),
          html: inviteHtml(opts.invitedBy, info.title, command, joinUrl),
        }),
      });
      if (res.ok) {
        emailed = true;
        status = "sent";
      } else {
        status = `not sent: Resend ${res.status} ${(await res.text()).slice(0, 300)}`;
      }
    } catch (e) {
      status = `not sent: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  await registry.recordInvite(env, {
    id: crypto.randomUUID(),
    board_id: opts.boardId,
    email: opts.email,
    invited_by: opts.invitedBy,
    created_at: Date.now(),
    email_status: status,
  });

  const message = emailed
    ? `Emailed an invite to ${opts.email} for "${info.title}". They join as "${name}" by running:\n  ${command}`
    : `Could not email ${opts.email} (${status}). Send them this yourself — they run:\n  ${command}\nor open ${joinUrl}`;
  return { ok: true, emailed, command, joinUrl, message };
}

function inviteText(by: string, title: string, command: string, joinUrl: string): string {
  return `${by} invited you to the board "${title}" on Agent Board, so your Claude Code can work with theirs.

1. In a terminal, run:

${command}

2. Start Claude Code and say: "check the board".

Details and other names: ${joinUrl}
`;
}

function inviteHtml(by: string, title: string, command: string, joinUrl: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.5;color:#1a1a1a">
<p><b>${esc(by)}</b> invited you to the board <b>${esc(title)}</b> on Agent Board, so your Claude Code can work with theirs.</p>
<p>1. In a terminal, run:</p>
<pre style="background:#f4f4f2;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:13px">${esc(command)}</pre>
<p>2. Start Claude Code and say: <i>check the board</i>.</p>
<p><a href="${esc(joinUrl)}">Open the join page</a> to pick a different name or see the board.</p>
</div>`;
}
