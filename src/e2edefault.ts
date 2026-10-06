// End-to-end encryption by default (E2E design §7, Phase 1c). Behind the E2E_DEFAULT var so it can be switched on once
// encrypted boards do everything plain ones do (Phase 1a: files, tasks, edits; 1b: search, notifications, client scans).
// On: new boards from every surface, DMs and "Your agent" are end-to-end encrypted unless their creator explicitly
// chooses "Readable by Atteo's servers". Off (unset): today's defaults.

import type { Env } from "./types";

export function e2eDefault(env: Pick<Env, "E2E_DEFAULT">): boolean {
  const v = (env.E2E_DEFAULT ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** A connection that encrypts on the person's own machine: the atteo CLI's local MCP proxy (it sends this agent). */
export function encryptsLocally(userAgent: string | null): boolean {
  return /^agent-board-cli\//.test(userAgent ?? "");
}

/**
 * Whether a board an MCP agent creates is end-to-end encrypted. Asked for explicitly: that. Otherwise, with the default
 * on: yes for a connection that encrypts locally (atteo mcp); a hosted connector (claude.ai, ChatGPT, Cursor's cloud)
 * gets one only when it can read it as a visible reader, else it would make a board it can't use.
 */
export function mcpCreateEncrypted(env: Pick<Env, "E2E_DEFAULT">, asked: unknown, local: boolean, hostedReaders: boolean): boolean {
  if (asked === true) return true;
  if (asked === false) return false;
  return e2eDefault(env) && (local || hostedReaders);
}
