import { describe, expect, it } from "vitest";
import {
  capLength,
  cleanForSpeech,
  DEFAULT_BUDGET,
  MAX_TEXT,
  NOT_SET_UP,
  speak,
  status,
  xaiSpeak,
  TtsProviderError,
  type EntryText,
  type TtsDeps,
  type TtsProvider,
  type Voice,
} from "../src/tts";

// A D1 stand-in over node:sqlite (Node 22+) running the real migrations, so the SQL under test is the SQL that ships.
// node: modules have no types in this project (no @types/node), hence the casts.
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0038_app_signin.sql", "0045_tts_usage.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, (import.meta as unknown as { url: string }).url), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => (/\bRETURNING\b/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] })),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database;
}

function fakeCache() {
  const m = new Map<string, { bytes: ArrayBuffer; type: string }>();
  return {
    m,
    match: async (k: string) => (m.has(k) ? new Response(m.get(k)!.bytes, { headers: { "content-type": m.get(k)!.type } }) : undefined),
    put: async (k: string, r: Response) => void m.set(k, { bytes: await r.arrayBuffer(), type: r.headers.get("content-type") ?? "" }),
  };
}

function fakeProvider(fail = false) {
  const calls: { text: string; voice: Voice }[] = [];
  const p: TtsProvider = {
    name: "fake",
    async speak(text, voice) {
      calls.push({ text, voice });
      if (fail) throw new TtsProviderError("boom");
      return { body: new Response(`MP3:${voice}:${text}`).body!, contentType: "audio/mpeg" };
    },
  };
  return { p, calls };
}

function setup(o: { provider?: TtsProvider | null; budget?: number; perMinute?: number; entry?: (b: string, s: number) => Promise<EntryText>; clock?: { t: number } } = {}) {
  const cache = fakeCache();
  const pending: Promise<unknown>[] = [];
  const clock = o.clock ?? { t: Date.UTC(2026, 9, 3, 12) };
  const deps: TtsDeps = {
    db: fakeD1(),
    provider: o.provider === undefined ? fakeProvider().p : o.provider,
    cache,
    budget: o.budget ?? DEFAULT_BUDGET,
    perMinute: o.perMinute ?? 30,
    entryText: o.entry ?? (async () => ({ text: "**Hello** from #12" })),
    waitUntil: (p) => void pending.push(p),
    now: () => clock.t,
  };
  return { deps, cache, settle: () => Promise.all(pending), clock };
}

describe("read aloud: cleaning text for speech", () => {
  it("drops code, keeps link text, turns URLs into their site", () => {
    const t = cleanForSpeech("Fix it:\n```ts\nconst x = 1;\n```\nSee [the PR](https://github.com/a/b/pull/3) and https://www.example.com/x?y=1.");
    expect(t).toBe("Fix it:\n\n(code omitted)\n\nSee the PR and example.com.");
  });
  it("an unclosed fence runs to the end", () => {
    expect(cleanForSpeech("Before\n```\nrm -rf /\nmore")).toBe("Before\n\n(code omitted)");
  });
  it("strips headings, quotes, bullets, emphasis, inline code, strikethrough, html, images", () => {
    const t = cleanForSpeech("## Plan\n> quoted **bold** and *it* and _em_\n- [x] ship `deploy.sh`\n* ~~old~~ new\n<b>hi</b> ![diagram](x.png) ![](y.png)");
    expect(t).toBe("Plan\nquoted bold and it and em\nship deploy.sh\nold new\nhi diagram");
  });
  it("leaves snake_case, math and #refs alone", () => {
    expect(cleanForSpeech("set max_retries in board #42: 2*3 = 6")).toBe("set max_retries in board #42: 2*3 = 6");
  });
  it("tables read as comma lists; rules vanish", () => {
    expect(cleanForSpeech("| a | b |\n|---|:-:|\n| 1 | 2 |\n\n---\nend")).toBe("a, b\n\n1, 2\n\nend");
  });
  it("caps at a sentence, else a word", () => {
    const s = "One sentence here. ".repeat(200);
    const c = capLength(s);
    expect(c.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(c.endsWith("here.")).toBe(true);
    const w = capLength("word ".repeat(1000));
    expect(w.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(w.endsWith("word")).toBe(true);
    expect(capLength("short")).toBe("short");
  });
});

describe("read aloud: POST /api/app/tts", () => {
  it("no key: 503 'Voice isn't set up yet' (after validation), status says disabled", async () => {
    const { deps } = setup({ provider: null });
    const r = await speak("vedu", { text: "hello" }, deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: NOT_SET_UP, fallback: "device" });
    expect((await speak("vedu", { text: "x".repeat(MAX_TEXT + 1) }, deps)).status).toBe(400);
    expect(await status("vedu", deps)).toEqual({ enabled: false, voice_default: "eve", voices: ["eve", "ara", "leo", "rex", "sal"], used_chars: 0, budget_chars: 900_000 });
  });

  it("validates: one of text or board+seq, length, voice, ids", async () => {
    const { deps } = setup();
    for (const [body, needle] of [
      [{}, "either text"],
      [null, "either text"],
      [{ text: "hi", board: "b_abcdefgh", seq: 1 }, "either text"],
      [{ text: 42 }, "must be a string"],
      [{ text: "x".repeat(MAX_TEXT + 1) }, "at most 2,000"],
      [{ text: "hi", voice: "darth" }, "Unknown voice"],
      [{ board: "nope", seq: 1 }, "board must be"],
      [{ board: "b_abcdefgh", seq: 0 }, "board must be"],
      [{ board: "b_abcdefgh" }, "board must be"],
      [{ text: "```\ncode only\n```" }, "Nothing to read"],
    ] as const) {
      const r = await speak("vedu", body, deps);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(((await r.json()) as any).error).toContain(needle);
    }
    expect((await speak("vedu", { text: "x".repeat(MAX_TEXT) }, deps)).status).toBe(200);
  });

  it("speaks cleaned text with the chosen voice, streams audio/mpeg, charges the budget", async () => {
    const f = fakeProvider();
    const { deps, settle } = setup({ provider: f.p });
    const r = await speak("vedu", { text: "**Hi** [there](https://x.com)", voice: "ARA" }, deps);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect(r.headers.get("x-tts-cache")).toBe("miss");
    expect(await r.text()).toBe("MP3:ara:Hi there");
    await settle();
    expect(f.calls).toEqual([{ text: "Hi there", voice: "ara" }]);
    expect((await status("vedu", deps)).used_chars).toBe(8);
  });

  it("board+seq: reads that message (resolver decides membership / encryption)", async () => {
    const f = fakeProvider();
    const seen: [string, number][] = [];
    const { deps } = setup({
      provider: f.p,
      entry: async (b, s) => {
        seen.push([b, s]);
        if (b === "b_notmine12") return { error: "board not found", status: 404 };
        if (b === "b_encrypted1") return { error: "End-to-end encrypted boards can't be read aloud", status: 400 };
        return { text: "# Done\nShipped `v2`. " + "More. ".repeat(600) };
      },
    });
    const ok = await speak("vedu", { board: "b_abcdefgh", seq: 7 }, deps);
    expect(ok.status).toBe(200);
    expect(f.calls[0].text.startsWith("Done\nShipped v2. More.")).toBe(true);
    expect(f.calls[0].text.length).toBeLessThanOrEqual(MAX_TEXT); // long messages are cut, not refused
    expect((await speak("vedu", { board: "b_notmine12", seq: 1 }, deps)).status).toBe(404);
    const enc = await speak("vedu", { board: "b_encrypted1", seq: 1 }, deps);
    expect(enc.status).toBe(400);
    expect(((await enc.json()) as any).fallback).toBe("device");
    expect(seen).toEqual([["b_abcdefgh", 7], ["b_notmine12", 1], ["b_encrypted1", 1]]);
    expect(f.calls.length).toBe(1);
  });

  it("replays come from the cache: no provider call, no budget spent", async () => {
    const f = fakeProvider();
    const { deps, settle, cache } = setup({ provider: f.p });
    await (await speak("vedu", { text: "same words" }, deps)).text();
    await settle();
    expect(cache.m.size).toBe(1);
    const again = await speak("jxn", { text: "same words" }, deps);
    expect(again.headers.get("x-tts-cache")).toBe("hit");
    expect(await again.text()).toBe("MP3:eve:same words");
    expect(f.calls.length).toBe(1);
    expect((await status("jxn", deps)).used_chars).toBe(0);
    const other = await speak("vedu", { text: "same words", voice: "leo" }, deps); // another voice is another recording
    expect(other.headers.get("x-tts-cache")).toBe("miss");
    expect(f.calls.length).toBe(2);
  });

  it("monthly budget: refuses past it with 429, per person, resets next month", async () => {
    const clock = { t: Date.UTC(2026, 9, 31, 23) };
    const { deps } = setup({ budget: 25, clock });
    expect((await speak("vedu", { text: "a".repeat(20) }, deps)).status).toBe(200);
    const over = await speak("vedu", { text: "b".repeat(6) }, deps);
    expect(over.status).toBe(429);
    expect(((await over.json()) as any).error).toContain("this month's read-aloud allowance (25 characters)");
    expect((await speak("vedu", { text: "c".repeat(5) }, deps)).status).toBe(200); // exactly up to the budget
    expect((await status("vedu", deps)).used_chars).toBe(25);
    expect((await speak("jxn", { text: "d".repeat(20) }, deps)).status).toBe(200); // someone else's budget
    clock.t = Date.UTC(2026, 10, 1, 0, 1);
    expect((await status("vedu", deps)).used_chars).toBe(0);
    expect((await speak("vedu", { text: "e".repeat(20) }, deps)).status).toBe(200);
  });

  it("a failed provider call is refunded and answers 502", async () => {
    const { deps } = setup({ provider: fakeProvider(true).p });
    const r = await speak("vedu", { text: "hello" }, deps);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).fallback).toBe("device");
    expect((await status("vedu", deps)).used_chars).toBe(0);
  });

  it("rate limit: N a minute per person, then 429 with retry-after; the next minute is fine", async () => {
    const clock = { t: Date.UTC(2026, 9, 3, 12) };
    const { deps } = setup({ perMinute: 3, clock });
    for (let i = 0; i < 3; i++) expect((await speak("vedu", { text: `n${i}` }, deps)).status).toBe(200);
    const r = await speak("vedu", { text: "n3" }, deps);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(((await r.json()) as any).error).toContain("at most 3 a minute");
    expect((await speak("jxn", { text: "n3" }, deps)).status).toBe(200);
    clock.t += 61_000;
    expect((await speak("vedu", { text: "n4" }, deps)).status).toBe(200);
  });
});

describe("read aloud: the xAI call", () => {
  it("POSTs api.x.ai/v1/tts with the key, voice, language and mp3 format; streams raw audio back", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("ID3audio", { headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const a = await xaiSpeak("xai-test", "Hello", "leo", fetcher);
    expect(await new Response(a.body).text()).toBe("ID3audio");
    expect(a.contentType).toBe("audio/mpeg");
    expect(seen!.url).toBe("https://api.x.ai/v1/tts");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer xai-test");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ text: "Hello", voice_id: "leo", language: "auto", output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 64000 } });
  });
  it("also takes the JSON form ({audio: base64})", async () => {
    const fetcher = (async () => Response.json({ audio: btoa("RAW"), content_type: "audio/mpeg", duration: 1 })) as unknown as typeof fetch;
    const a = await xaiSpeak("k", "Hi", "eve", fetcher);
    expect(await new Response(a.body).text()).toBe("RAW");
  });
  it("errors and network failures become TtsProviderError (no xAI body passed on)", async () => {
    const bad = (async () => new Response("secret detail", { status: 401 })) as unknown as typeof fetch;
    await expect(xaiSpeak("k", "Hi", "eve", bad)).rejects.toThrow("xAI TTS answered 401");
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(xaiSpeak("k", "Hi", "eve", down)).rejects.toBeInstanceOf(TtsProviderError);
  });
});
