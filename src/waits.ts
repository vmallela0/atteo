// Waits (an agent's `wait`, the web and API long-polls) are held here in the Worker, which is billed for CPU only,
// on a hibernating socket to the board's Durable Object. The board sleeps until something arrives and then sends
// "go". (Holding them inside the board kept it awake and billed for its whole duration.)

import type { Board } from "./board";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type WaitFor = { kind: "agent"; user: string; session?: string; forMe?: boolean } | { kind: "any"; after: number };

/** Resolves true when the board says something arrived (or the member was removed), false at the time limit or once
 *  `signal` aborts (a newer wait from the same session took over: limits.beginWait). */
export async function waitForBoard(stub: DurableObjectStub<Board>, q: WaitFor, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const qs = q.kind === "agent" ? `kind=agent&user=${encodeURIComponent(q.user)}${q.session ? `&session=${encodeURIComponent(q.session)}` : ""}${q.forMe ? "&for=me" : ""}` : `kind=any&after=${q.after}`;
  // A deploy restarts the board and drops the socket: wait on the new one for the time that's left.
  while (deadline - Date.now() > 250 && !signal?.aborted) {
    let ws: WebSocket | null = null;
    try {
      ws = (await stub.fetch(`https://board/wait?${qs}`, { headers: { Upgrade: "websocket" } })).webSocket;
    } catch {}
    if (!ws) {
      await sleep(500);
      continue;
    }
    ws.accept();
    const socket = ws;
    const outcome = await new Promise<"go" | "closed" | "timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
      const done = (o: "go" | "closed" | "timeout") => () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        resolve(o);
      };
      const aborted = done("timeout");
      signal?.addEventListener("abort", aborted);
      socket.addEventListener("message", done("go"));
      socket.addEventListener("close", done("closed"));
      socket.addEventListener("error", done("closed"));
    });
    try {
      socket.close(1000, "done");
    } catch {}
    if (outcome !== "closed") return outcome === "go";
    await sleep(300);
  }
  return false;
}

/** The original four 250ms rounds still bound how long a wake gathers the same burst. */
export const SETTLE_MS = 250;
export const SETTLE_ROUNDS = 4;
export const QUIET_MS = 40;

/**
 * After a wake: `more` takes what has landed since (advancing the reader), every QUIET_MS until a check finds
 * nothing new or `full()`. A continuous burst gets at most SETTLE_MS * SETTLE_ROUNDS ms of gathering time.
 */
export async function settle(more: () => Promise<number>, full: () => boolean): Promise<void> {
  const deadline = Date.now() + SETTLE_MS * SETTLE_ROUNDS;
  while (!full()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(QUIET_MS, remaining));
    if (!(await more())) return;
  }
}
