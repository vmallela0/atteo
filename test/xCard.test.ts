import { describe, expect, it } from "vitest";
import { boardTail } from "../src/html";
import { CARD_SECONDS, MAX_BYTES, MISS_SECONDS, OEMBED_ORIGIN, PER_MINUTE, X_CARD_JS, cacheKey, decodeEntities, fetchOembed, getCard, oembedUrl, parseOembed, parseXUrl, route, type XCardDeps } from "../src/xCard";

// What publish.x.com answered for https://x.com/unusual_whales/status/2107938834180874486 (Oct 7 2026).
const WHALES = {
  url: "https://x.com/unusual_whales/status/2107938834180874486",
  author_name: "unusual_whales",
  author_url: "https://x.com/unusual_whales",
  html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">BREAKING: Trump will award Elon Musk the National Medal of Science at the White House Thursday.  <br><br>Sergey Brin, Jensen Huang and Lisa Su will also receive the science medal, while Michael Dell and Satya Nadella will receive the technology medal.</p>&mdash; unusual_whales (@unusual_whales) <a href="https://x.com/unusual_whales/status/2107938834180874486?ref_src=twsrc%5Etfw">October 7, 2026</a></blockquote>\n\n',
  width: 550,
  type: "rich",
  provider_name: "X",
  version: "1.0",
};
const ID = "2107938834180874486";

const jsonRes = (j: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, ...init });

/** A fetch that records what it was asked and answers with `answer`. */
function fakeFetch(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { f, calls };
}

/** An in-memory Cache with the max-age it was given. */
function fakeCache() {
  const m = new Map<string, Response>();
  return {
    m,
    match: async (k: RequestInfo | URL) => m.get(String(k))?.clone(),
    put: async (k: RequestInfo | URL, r: Response) => void m.set(String(k), r),
  } as unknown as Pick<Cache, "match" | "put"> & { m: Map<string, Response> };
}

describe("parseXUrl", () => {
  it("finds the handle and id on x.com, twitter.com, www. and mobile., with any query", () => {
    expect(parseXUrl("https://x.com/unusual_whales/status/2107938834180874486?s=46")).toEqual({ handle: "unusual_whales", id: ID });
    expect(parseXUrl("https://twitter.com/jack/status/20")).toEqual({ handle: "jack", id: "20" });
    expect(parseXUrl("https://www.twitter.com/jack/status/20")).toEqual({ handle: "jack", id: "20" });
    expect(parseXUrl("https://mobile.twitter.com/jack/status/20/photo/1")).toEqual({ handle: "jack", id: "20" });
    expect(parseXUrl("https://mobile.x.com/Jack_2/status/20#frag")).toEqual({ handle: "Jack_2", id: "20" });
    expect(parseXUrl("https://X.com/jack/status/20?t=abc&s=19")).toEqual({ handle: "jack", id: "20" });
    expect(parseXUrl("https://twitter.com/jack/statuses/20")).toEqual({ handle: "jack", id: "20" });
  });

  it("ignores links that aren't to one post", () => {
    for (const u of [
      "https://x.com/jack",
      "https://x.com/jack/likes",
      "https://x.com/search?q=status/20",
      "https://x.com/i/lists/123",
      "http://x.com/jack/status/20", // not https
      "https://x.com.evil.example/jack/status/20",
      "https://evilx.com/jack/status/20",
      "https://notx.com/jack/status/20",
      "https://x.com/jack/status/abc",
      "https://x.com/jack/status/20abc",
      "https://x.com/waytoolonghandle_x/status/20",
      "https://example.com/?u=https://x.com/jack/status/20",
    ])
      expect(parseXUrl(u), u).toBeNull();
  });
});

describe("oembedUrl", () => {
  it("asks only the fixed oEmbed host, for a canonical twitter.com link", () => {
    const u = new URL(oembedUrl("20", "jack"));
    expect(u.origin).toBe(OEMBED_ORIGIN);
    expect(u.pathname).toBe("/oembed");
    expect(u.searchParams.get("url")).toBe("https://twitter.com/jack/status/20");
    expect(u.searchParams.get("omit_script")).toBe("1");
    expect(u.searchParams.get("dnt")).toBe("true");
    // A handle that isn't one becomes "i" (X resolves /i/status/<id> to the real author).
    expect(new URL(oembedUrl("20", "x/../../evil")).searchParams.get("url")).toBe("https://twitter.com/i/status/20");
  });
});

describe("parseOembed", () => {
  it("takes the author, @handle, words (line breaks kept) and date; links to x.com", () => {
    expect(parseOembed(WHALES, ID)).toEqual({
      author: "unusual_whales",
      handle: "unusual_whales",
      text: "BREAKING: Trump will award Elon Musk the National Medal of Science at the White House Thursday.\n\nSergey Brin, Jensen Huang and Lisa Su will also receive the science medal, while Michael Dell and Satya Nadella will receive the technology medal.",
      date: "October 7, 2026",
      url: `https://x.com/unusual_whales/status/${ID}`,
    });
  });

  it("keeps a link's words, decodes entities, and markup in the words stays text", () => {
    const html = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;hi&quot; &#39;x&#39; &#x1F680; <a href="https://twitter.com/hashtag/ai">#ai</a> <a href="https://t.co/abc">pic.twitter.com/abc</a></p>&mdash; Jack D (@jack) <a href="https://twitter.com/jack/status/20">March 21, 2006</a></blockquote>';
    const c = parseOembed({ author_name: "Jack D", author_url: "https://twitter.com/jack", html }, "20")!;
    expect(c.text).toBe(`<script>alert(1)</script> & "hi" 'x' 🚀 #ai pic.twitter.com/abc`);
    expect(c.author).toBe("Jack D");
    expect(c.handle).toBe("jack");
    expect(c.date).toBe("March 21, 2006");
  });

  it("finds the handle in the html when author_url isn't an X profile", () => {
    const c = parseOembed({ ...WHALES, author_url: "https://evil.example/x" }, ID)!;
    expect(c.handle).toBe("unusual_whales");
    expect(c.url).toBe(`https://x.com/unusual_whales/status/${ID}`);
  });

  it("is null for anything that isn't a post", () => {
    expect(parseOembed(null, "1")).toBeNull();
    expect(parseOembed("<!DOCTYPE html>", "1")).toBeNull();
    expect(parseOembed({ html: "<div>hi</div>" }, "1")).toBeNull();
    expect(parseOembed({ author_name: "a", html: 42 }, "1")).toBeNull();
    expect(parseOembed({ author_name: "a", author_url: "https://evil.example", html: '<blockquote class="twitter-tweet"><p>x</p></blockquote>' }, "1")).toBeNull();
  });

  it("decodes numeric entities safely", () => {
    expect(decodeEntities("&#0; &#xD800; &#x110000; &bogus; &AMP;")).toBe("   &bogus; &");
  });
});

describe("fetchOembed", () => {
  it("doesn't follow redirects, and asks with a timeout", async () => {
    const { f, calls } = fakeFetch(() => jsonRes(WHALES));
    expect((await fetchOembed(ID, "unusual_whales", { fetch: f }))?.handle).toBe("unusual_whales");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(`${OEMBED_ORIGIN}/oembed?`)).toBe(true);
    expect(calls[0].init?.redirect).toBe("manual");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is null on a redirect, an error, an HTML page (a deleted post), bad JSON, a body over the cap, or a throw", async () => {
    const answers: (() => Response)[] = [
      () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }),
      () => jsonRes({ error: "x" }, { status: 404 }),
      () => new Response("<!DOCTYPE html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
      () => new Response(JSON.stringify({ ...WHALES, pad: "x".repeat(MAX_BYTES) }), { status: 200, headers: { "content-type": "application/json" } }),
      () => {
        throw new Error("network");
      },
    ];
    for (const a of answers) expect(await fetchOembed("1", "jack", { fetch: fakeFetch(a).f })).toBeNull();
  });

  it("gives up after the timeout", async () => {
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch;
    const t0 = Date.now();
    expect(await fetchOembed("1", "jack", { fetch: f, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("getCard (cached)", () => {
  it("asks X once a day per post: a card is cached for a day", async () => {
    const cache = fakeCache();
    const { f, calls } = fakeFetch(() => jsonRes(WHALES));
    const deps: XCardDeps = { fetch: f, cache };
    expect((await getCard(ID, "unusual_whales", deps)).cache).toBe("miss");
    const again = await getCard(ID, "someone_else", deps);
    expect(again.cache).toBe("hit");
    expect(again.card?.handle).toBe("unusual_whales");
    expect(calls).toHaveLength(1);
    expect(cache.m.get(cacheKey(ID))?.headers.get("cache-control")).toBe(`public, max-age=${CARD_SECONDS}`);
  });

  it("caches a failure for a few minutes", async () => {
    const cache = fakeCache();
    const { f, calls } = fakeFetch(() => new Response("nope", { status: 500 }));
    const deps: XCardDeps = { fetch: f, cache };
    expect((await getCard("5", "jack", deps)).card).toBeNull();
    expect(await getCard("5", "jack", deps)).toEqual({ card: null, cache: "hit" });
    expect(calls).toHaveLength(1);
    expect(cache.m.get(cacheKey("5"))?.headers.get("cache-control")).toBe(`public, max-age=${MISS_SECONDS}`);
  });

  it("shares one ask between requests for the same post at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, calls } = fakeFetch(async () => (await gate, jsonRes(WHALES)));
    const deps: XCardDeps = { fetch: f, cache: null };
    const a = getCard(ID, "u", deps), b = getCard(ID, "u", deps);
    release();
    expect((await a).card?.handle).toBe("unusual_whales");
    expect((await b).card?.handle).toBe("unusual_whales");
    expect(calls).toHaveLength(1);
  });
});

describe("GET /api/x-card", () => {
  const u = (q: string) => new URL(`https://atteo.test/api/x-card?${q}`);
  const deps = (now?: number) => ({ fetch: fakeFetch(() => jsonRes(WHALES)).f, cache: null, now: now ? () => now : undefined });

  it("needs a signed-in person or an agent token", async () => {
    const r = await route(u(`id=${ID}`), null, deps());
    expect(r.status).toBe(401);
  });

  it("answers the card for a person or an agent", async () => {
    for (const who of ["xc-person", "xc-agent"]) {
      const r = await route(u(`id=${ID}&handle=unusual_whales`), { name: who }, deps());
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/json/);
      expect(await r.json()).toEqual(parseOembed(WHALES, ID));
    }
  });

  it("refuses ids and handles that aren't X's", async () => {
    expect((await route(u("id=abc"), { name: "xc-bad" }, deps())).status).toBe(400);
    expect((await route(u(""), { name: "xc-bad" }, deps())).status).toBe(400);
    expect((await route(u("id=1&handle=a/b"), { name: "xc-bad" }, deps())).status).toBe(400);
    expect((await route(u("id=123456789012345678901"), { name: "xc-bad" }, deps())).status).toBe(400);
  });

  it("is 404 when X has no post", async () => {
    const r = await route(u("id=1"), { name: "xc-404" }, { fetch: fakeFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })).f, cache: null });
    expect(r.status).toBe(404);
  });

  it(`is rate limited: ${PER_MINUTE} a minute each`, async () => {
    const now = Date.parse("2026-10-07T12:00:30Z");
    for (let i = 0; i < PER_MINUTE; i++) expect((await route(u(`id=${ID}`), { name: "xc-busy" }, deps(now))).status).toBe(200);
    const r = await route(u(`id=${ID}`), { name: "xc-busy" }, deps(now));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    // someone else isn't
    expect((await route(u(`id=${ID}`), { name: "xc-other" }, deps(now))).status).toBe(200);
  });
});

describe("the board page's script", () => {
  it("sets what the server sends as text, never as HTML", () => {
    expect(X_CARD_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(X_CARD_JS).toContain("textContent");
    // It parses as a script, and its link check is the server's.
    expect(() => new Function(X_CARD_JS)).not.toThrow();
    expect(X_CARD_JS).toContain(JSON.stringify(/^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,20})(?:[/?#]|$)/.source));
  });

  it("is on every board but encrypted ones (the server would learn which posts their messages link to)", () => {
    for (const f of ["0000", "1001", "0011"]) expect(boardTail(f)!.js).toContain(X_CARD_JS);
    for (const f of ["0100", "1101"]) expect(boardTail(f)!.js).not.toContain(X_CARD_JS);
  });
});
