// A hibernating wake channel per person's mailbox. Mail stays in D1; this object carries no delivery state.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export class MailboxSignal extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/wait" || request.headers.get("Upgrade") !== "websocket") return new Response("Not found", { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async notify(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send("go"); } catch { /* A disconnected waiter will use its safety poll. */ }
    }
  }
}
