// Nothing reaches xAI without the person's OK, server-side (App Review 5.1.2(i), jxn's agent #4386): POST /api/app/tts and
// starting a voice session answer 403 {needs_consent} until display.xai_ok is on, whatever the client. Ending a session
// and the autosend check stay open (they're ours, so a call open at revoke still settles). No fetch to xAI happens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { route as ttsRoute } from "../src/tts";
import { route as voiceRoute } from "../src/voice";
import { mergeDisplay, DISPLAY_DEFAULTS } from "../src/social";
import type { Env } from "../src/types";

function env(display: Record<string, unknown> | null): Env {
  const row = { display: display ? JSON.stringify(display) : null };
  const stmt: any = { bind: () => stmt, first: async () => row, all: async () => ({ results: [] }), run: async () => ({}) };
  return { XAI_API_KEY: "xai-test", DB: { prepare: () => stmt, batch: async () => [] } } as unknown as Env;
}
const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const person = { name: "maya", via: "person" as const };
const post = (path: string, body: unknown) => new Request(`https://atteo.dev${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => vi.restoreAllMocks());

describe("xAI consent, on the server", () => {
  it("POST /api/app/tts is refused without the OK, and nothing is fetched", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const r = await ttsRoute(post("/api/app/tts", { text: "Hi" }), env({}), ctx, "/api/app/tts", person);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ needs_consent: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("starting a voice session is refused without the OK, and nothing is fetched", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const r = await voiceRoute(post("/api/app/voice/session", { hands_free: true }), env({ xai_ok: false }), "/api/app/voice/session", person);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ needs_consent: true });
    expect(f).not.toHaveBeenCalled();
  });

  it("ending a session and the autosend check aren't gated: they never reach xAI", async () => {
    const end = await voiceRoute(post("/api/app/voice/session/end", { session_id: "nope" }), env({}), "/api/app/voice/session/end", person);
    expect(end.status).not.toBe(403);
    const auto = await voiceRoute(post("/api/app/voice/autosend", { text: "x" }), env({}), "/api/app/voice/autosend", person);
    expect(auto.status).not.toBe(403);
  });

  it("with the OK, tts goes past the gate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("no", { status: 500 }));
    const r = await ttsRoute(post("/api/app/tts", { text: "Hi" }), env({ xai_ok: true }), ctx, "/api/app/tts", person).catch(() => null);
    const j = r ? ((await r.clone().json().catch(() => ({}))) as { needs_consent?: boolean }) : {};
    expect(j.needs_consent).toBeUndefined();
  });

  it("xai_ok is a display setting, off by default, set and cleared like the others", () => {
    expect(DISPLAY_DEFAULTS.xai_ok).toBe(false);
    expect(mergeDisplay(DISPLAY_DEFAULTS, { xai_ok: true }).xai_ok).toBe(true);
    expect(mergeDisplay({ ...DISPLAY_DEFAULTS, xai_ok: true }, { xai_ok: false }).xai_ok).toBe(false);
    expect(() => mergeDisplay(DISPLAY_DEFAULTS, { xai_ok: "yes" })).toThrow();
  });
});
