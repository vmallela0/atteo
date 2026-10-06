import { beforeAll, describe, expect, it } from "vitest";
import { parseCard } from "../src/card";
import {
  GITHUB_API,
  MAX_WEBHOOK_BYTES,
  NOT_SET_UP,
  boardNoteFromGithub,
  githubChangeCtx,
  githubChangeNotification,
  handleWebhook,
  inboundEnabled,
  notifyGithubChangeCard,
  outboundEnabled,
  pemToPkcs8,
  postGithubChange,
  prNumberFromUrl,
  signAppJwt,
  verifySignature,
  type GithubHttp,
} from "../src/githubApp";

const secret = "ci-github-webhook-secret";

async function sign(payload: string, key = secret) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

const headers = (event: string, signature: string | null, delivery = "11111111-2222-3333-4444-555555555555") => ({
  event,
  signature,
  delivery,
});

const prOpened = {
  action: "opened",
  number: 44,
  pull_request: {
    number: 44,
    title: "Pin the header",
    html_url: "https://github.com/vmallela0/agent-soup/pull/44",
    merged: false,
  },
  repository: { full_name: "vmallela0/agent-soup", html_url: "https://github.com/vmallela0/agent-soup" },
  sender: { login: "alice" },
  installation: { id: 99 },
};

describe("GitHub webhook signatures", () => {
  it("accepts a valid sha256 HMAC and rejects tampering, wrong secrets, and missing headers", async () => {
    const body = JSON.stringify({ zen: "Responsive is better than fast." });
    const h = await sign(body);
    expect(await verifySignature(body, h, secret)).toBe(true);
    expect(await verifySignature(body, h.toUpperCase().replace("SHA256", "sha256"), secret)).toBe(true);
    expect(await verifySignature(body + " ", h, secret)).toBe(false);
    expect(await verifySignature(body, h, "other-secret")).toBe(false);
    expect(await verifySignature(body, null, secret)).toBe(false);
    expect(await verifySignature(body, "sha1=deadbeef", secret)).toBe(false);
    expect(await verifySignature(body, `sha256=${"ab".repeat(32)}`, secret)).toBe(false);
    expect(await verifySignature(body, h, "")).toBe(false);
  });
});

describe("GitHub event parsing", () => {
  it("maps pull_request opened, merged, and ignored actions", () => {
    const opened = boardNoteFromGithub("pull_request", prOpened)!;
    expect(opened.title).toBe("PR opened");
    expect(opened.text).toContain("alice opened #44");
    expect(opened.text).toContain("Pin the header");
    expect(opened.text).toContain("https://github.com/vmallela0/agent-soup/pull/44");
    expect(opened.data.github.repo).toBe("vmallela0/agent-soup");
    expect(opened.data.github.number).toBe(44);

    const merged = boardNoteFromGithub("pull_request", { ...prOpened, action: "closed", pull_request: { ...prOpened.pull_request, merged: true } })!;
    expect(merged.title).toBe("PR merged");
    expect(merged.text).toContain("alice merged #44");

    const closed = boardNoteFromGithub("pull_request", { ...prOpened, action: "closed" })!;
    expect(closed.title).toBe("PR closed");
    expect(boardNoteFromGithub("pull_request", { ...prOpened, action: "labeled" })).toBeNull();
    expect(boardNoteFromGithub("pull_request", { action: "opened" })!.text).toContain("a PR");
  });

  it("maps a submitted review, a PR comment, completed checks, and a push; ignores the rest", () => {
    const review = boardNoteFromGithub("pull_request_review", {
      action: "submitted",
      pull_request: prOpened.pull_request,
      review: { state: "APPROVED" },
      repository: prOpened.repository,
      sender: { login: "bob" },
    })!;
    expect(review.title).toBe("PR review");
    expect(review.text).toContain("bob approved #44");

    const comment = boardNoteFromGithub("issue_comment", {
      action: "created",
      issue: { number: 44, title: "Pin the header", html_url: prOpened.pull_request.html_url, pull_request: { url: "https://api.github.com/repos/vmallela0/agent-soup/pulls/44" } },
      repository: prOpened.repository,
      sender: { login: "cara" },
    })!;
    expect(comment.title).toBe("PR comment");
    expect(comment.text).toContain("cara commented on #44");
    expect(boardNoteFromGithub("issue_comment", { action: "created", issue: { number: 8, title: "a bug" }, repository: prOpened.repository, sender: { login: "cara" } })).toBeNull();

    const checks = boardNoteFromGithub("check_suite", {
      action: "completed",
      check_suite: { conclusion: "success", head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", html_url: "https://github.com/vmallela0/agent-soup/actions" },
      repository: prOpened.repository,
      sender: { login: "github-actions[bot]" },
    })!;
    expect(checks.title).toBe("Checks done");
    expect(checks.text).toContain("finished success");
    expect(checks.data.github.sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    const push = boardNoteFromGithub("push", {
      ref: "refs/heads/cursor/github-app",
      compare: "https://github.com/vmallela0/agent-soup/compare/aaa...bbb",
      commits: [{ id: "1" }, { id: "2" }],
      repository: prOpened.repository,
      sender: { login: "alice" },
    })!;
    expect(push.title).toBe("Push");
    expect(push.text).toContain("2 commits");
    expect(push.text).toContain("cursor/github-app");
    expect(boardNoteFromGithub("star", { action: "created" })).toBeNull();
    expect(boardNoteFromGithub("pull_request", "not json")).toBeNull();
  });

  it("does not turn a payload that looks like a secret into a board note", () => {
    const j = (...p: string[]) => p.join("");
    const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("");
    const key = j("ghp_", mix(36));
    expect(
      boardNoteFromGithub("pull_request", {
        ...prOpened,
        pull_request: { ...prOpened.pull_request, title: `leak ${key}` },
      }),
    ).toBeNull();
  });
});

describe("handleWebhook stub", () => {
  it("is off without a secret, and never posts", async () => {
    expect(inboundEnabled({})).toBe(false);
    expect(inboundEnabled({ GITHUB_WEBHOOK_SECRET: "  " })).toBe(false);
    const r = await handleWebhook({}, "{}", headers("ping", "sha256=ab"));
    expect(r).toEqual({ status: 503, error: NOT_SET_UP });
  });

  it("accepts a signed ping and a signed pull_request, rejects a forgery, and ignores unknown events", async () => {
    const env = { GITHUB_WEBHOOK_SECRET: secret };
    const pingBody = JSON.stringify({ zen: "Anything added dilutes everything else." });
    const ping = await handleWebhook(env, pingBody, headers("ping", await sign(pingBody)));
    expect(ping).toEqual({ status: 200, ok: true, applied: "ping" });

    const prBody = JSON.stringify(prOpened);
    const pr = await handleWebhook(env, prBody, headers("pull_request", await sign(prBody), "deliv-1"));
    expect(pr.status).toBe(200);
    if (pr.status === 200) {
      expect(pr.applied).toBe("note");
      expect(pr.note?.title).toBe("PR opened");
      expect(pr.note?.data.github.delivery).toBe("deliv-1");
    }

    expect(await handleWebhook(env, prBody, headers("pull_request", await sign(prBody, "wrong")))).toEqual({ status: 400, error: "bad signature" });
    expect(await handleWebhook(env, "{", headers("ping", await sign("{")))).toEqual({ status: 400, error: "invalid json" });
    expect(await handleWebhook(env, "{}", headers("", await sign("{}")))).toEqual({ status: 400, error: "missing X-GitHub-Event" });

    const instBody = JSON.stringify({ action: "created", installation: { id: 1 } });
    const inst = await handleWebhook(env, instBody, headers("installation", await sign(instBody)));
    expect(inst).toEqual({ status: 200, ok: true, applied: "installation:created" });

    const other = JSON.stringify({ action: "created" });
    expect(await handleWebhook(env, other, headers("fork", await sign(other)))).toEqual({ status: 200, ok: true, applied: "ignored" });
  });

  it("refuses an oversized payload before parsing", async () => {
    const env = { GITHUB_WEBHOOK_SECRET: secret };
    const raw = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    expect(await handleWebhook(env, raw, headers("ping", await sign(raw)))).toEqual({ status: 413, error: "payload too large" });
  });
});

describe("outbound change-card payloads", () => {
  const ctx = {
    seq: 12,
    author: "vedu",
    boardId: "b_skyvcqtm7fei",
    boardUrl: "https://atteo.dev/b/b_skyvcqtm7fei#e12",
  };

  it("builds a check-run and a PR comment", () => {
    const { card } = parseCard({
      repo: "vmallela0/agent-soup",
      branch: "cursor/github-app",
      base: "main",
      pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
      ci: "passing",
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "GitHub app stub" }],
      files: [{ path: "src/githubApp.ts", added: 10, removed: 0 }],
    });
    expect(prNumberFromUrl(card.pr_url)).toBe(44);
    const payloads = githubChangeNotification(card, { ...ctx, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(payloads).toHaveLength(2);
    expect(payloads[0].kind).toBe("check_run");
    expect(payloads[0].ready).toBe(true);
    expect(payloads[0].url).toBe("https://api.github.com/repos/vmallela0/agent-soup/check-runs");
    expect(payloads[0].body.head_sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(payloads[0].body.conclusion).toBe("success");
    expect(payloads[0].body.external_id).toBe("atteo:b_skyvcqtm7fei:12");
    expect(payloads[1].kind).toBe("issue_comment");
    expect(payloads[1].ready).toBe(true);
    expect(String((payloads[1].body as { body: string }).body)).toContain("change card #12");
  });

  it("marks a short sha not ready, and needs owner/name", () => {
    const { card } = parseCard({
      repo: "vmallela0/agent-soup",
      branch: "x",
      commits: [{ sha: "abc1234def56", title: "short" }],
    });
    const [check] = githubChangeNotification(card, ctx);
    expect(check.ready).toBe(false);
    expect(check.reason).toMatch(/40-character/);
    const full = githubChangeNotification(card, { ...ctx, headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    expect(full[0].ready).toBe(true);
    expect(full[0].body.head_sha).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(githubChangeNotification(parseCard({ branch: "x" }).card, ctx)[0].ready).toBe(false);
  });
});

function derPem(label: string, der: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < der.length; i += 0x8000) bin += String.fromCharCode(...der.subarray(i, i + 0x8000));
  const b64 = btoa(bin).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

function readLen(buf: Uint8Array, i: number): { n: number; i: number } {
  const first = buf[i++];
  if (first < 128) return { n: first, i };
  const bytes = first & 127;
  let n = 0;
  for (let k = 0; k < bytes; k++) n = (n << 8) | buf[i++];
  return { n, i };
}

/** Inner RSAPrivateKey OCTET STRING from a PKCS#8 RSA key (for PKCS#1 PEM tests). */
function pkcs1FromPkcs8(pkcs8: Uint8Array): Uint8Array {
  let i = 0;
  if (pkcs8[i++] !== 0x30) throw new Error("pkcs8");
  ({ i } = readLen(pkcs8, i));
  if (pkcs8[i++] !== 0x02) throw new Error("pkcs8 version");
  ({ i } = readLen(pkcs8, i));
  i += 1;
  if (pkcs8[i++] !== 0x30) throw new Error("pkcs8 alg");
  const alg = readLen(pkcs8, i);
  i = alg.i + alg.n;
  if (pkcs8[i++] !== 0x04) throw new Error("pkcs8 octet");
  const oct = readLen(pkcs8, i);
  return pkcs8.subarray(oct.i, oct.i + oct.n);
}

async function testAppKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return { pkcs8: derPem("PRIVATE KEY", pkcs8), pkcs1: derPem("RSA PRIVATE KEY", pkcs1FromPkcs8(pkcs8)) };
}

type GhCall = { method: string; url: string; body: unknown; authorization: string };

function mockGithub(script: (url: URL, method: string, body: unknown) => { status: number; json?: unknown }, calls: GhCall[]): GithubHttp {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe(GITHUB_API);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const authorization = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
    calls.push({ method, url: url.pathname + url.search, body, authorization });
    const r = script(url, method, body);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("outbound posting", () => {
  const ctx = {
    seq: 12,
    author: "vedu",
    boardId: "b_skyvcqtm7fei",
    boardUrl: "https://atteo.dev/b/b_skyvcqtm7fei#e12",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const { card } = parseCard({
    repo: "vmallela0/agent-soup",
    branch: "cursor/github-app",
    base: "main",
    pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
    ci: "passing",
    commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "GitHub app outbound" }],
    files: [{ path: "src/githubApp.ts", added: 10, removed: 0 }],
  });
  let keys: { pkcs8: string; pkcs1: string };
  beforeAll(async () => {
    keys = await testAppKeys();
  });

  it("never fetches when App credentials are missing, and a bad PEM does not either", async () => {
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub(() => {
      throw new Error("fetch must not run");
    }, calls);
    expect(outboundEnabled({})).toBe(false);
    const skipped = await postGithubChange({}, card, ctx, { fetch: fetchImpl });
    expect(skipped.posted).toBe(false);
    expect(skipped.reason).toContain("aren't set");
    expect(calls).toHaveLength(0);

    const bad = await postGithubChange({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "not-a-real-key" }, card, ctx, { fetch: fetchImpl });
    expect(bad.posted).toBe(false);
    expect(bad.reason).toMatch(/private key isn't usable/);
    expect(calls).toHaveLength(0);
  });

  it("imports GitHub's PKCS#1 PEM and mints an RS256 App JWT", async () => {
    expect(pemToPkcs8(keys.pkcs1)).not.toBeNull();
    expect(pemToPkcs8(keys.pkcs8.replace(/\n/g, "\\n"))).not.toBeNull();
    const jwt = await signAppJwt("4242", keys.pkcs1);
    expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [h, p] = jwt!.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe(4242);
    expect(payload.exp - payload.iat).toBe(9 * 60);
  });

  it("creates a Check run and a PR comment through mocked GitHub HTTP", async () => {
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub((url, method) => {
      if (method === "GET" && url.pathname.endsWith("/installation")) return { status: 200, json: { id: 99 } };
      if (method === "POST" && url.pathname.endsWith("/access_tokens")) return { status: 201, json: { token: "ghs_test_installation_token" } };
      if (method === "GET" && url.pathname.includes("/check-runs")) return { status: 200, json: { check_runs: [] } };
      if (method === "POST" && url.pathname.endsWith("/check-runs")) return { status: 201, json: { id: 501 } };
      if (method === "POST" && url.pathname.endsWith("/comments")) return { status: 201, json: { id: 77 } };
      return { status: 404, json: { message: "unexpected" } };
    }, calls);

    const r = await postGithubChange({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: keys.pkcs8 }, card, ctx, { fetch: fetchImpl });
    expect(r.posted).toBe(true);
    expect(r.calls?.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /repos/vmallela0/agent-soup/check-runs", "POST /repos/vmallela0/agent-soup/issues/44/comments"]);
    expect(r.calls?.[0].id).toBe(501);
    expect(r.calls?.[1].id).toBe(77);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /repos/vmallela0/agent-soup/installation",
      "POST /app/installations/99/access_tokens",
      "GET /repos/vmallela0/agent-soup/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs?check_name=Atteo",
      "POST /repos/vmallela0/agent-soup/check-runs",
      "POST /repos/vmallela0/agent-soup/issues/44/comments",
    ]);
    expect(calls[0].authorization.startsWith("Bearer eyJ")).toBe(true);
    expect(calls[3].authorization).toBe("Bearer ghs_test_installation_token");
    const check = calls[3].body as { name: string; head_sha: string; output: { summary: string }; details_url: string };
    expect(check.name).toBe("Atteo");
    expect(check.head_sha).toBe(ctx.headSha);
    expect(check.details_url).toBe(ctx.boardUrl);
    expect(check.output.summary).not.toMatch(/ghs_|ghp_|BEGIN /);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("ghs_test_installation_token");
    expect(JSON.stringify(r)).not.toContain(keys.pkcs8.slice(0, 40));
  });

  it("PATCHes an existing Check run and can skip the PR comment", async () => {
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub((url, method) => {
      if (method === "GET" && url.pathname.endsWith("/installation")) return { status: 200, json: { id: 99 } };
      if (method === "POST" && url.pathname.endsWith("/access_tokens")) return { status: 201, json: { token: "ghs_test_installation_token" } };
      if (method === "GET" && url.pathname.includes("/check-runs")) {
        return { status: 200, json: { check_runs: [{ id: 501, external_id: "atteo:b_skyvcqtm7fei:12" }] } };
      }
      if (method === "PATCH" && url.pathname.endsWith("/check-runs/501")) return { status: 200, json: { id: 501 } };
      return { status: 404, json: { message: "unexpected" } };
    }, calls);

    const r = await postGithubChange({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: keys.pkcs8, GITHUB_APP_INSTALLATION_ID: "99" }, card, ctx, {
      fetch: fetchImpl,
      comment: false,
    });
    expect(r.posted).toBe(true);
    expect(calls.some((c) => c.url.includes("/installation") && c.method === "GET")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/check-runs/501"))).toBe(true);
    expect((calls.find((c) => c.method === "PATCH")?.body as { head_sha?: string }).head_sha).toBeUndefined();
  });

  it("does not post board secrets or private text, and does not fetch when the payload looks like a secret", async () => {
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub(() => {
      throw new Error("fetch must not run");
    }, calls);
    const leak = `ghp_${Array.from({ length: 36 }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("")}`;
    const dirty = parseCard({
      repo: "vmallela0/agent-soup",
      branch: `leak-${leak}`,
      pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
      ci: "passing",
    }).card;
    const formatted = githubChangeNotification(dirty, ctx);
    expect(formatted.every((p) => !p.ready)).toBe(true);
    expect(formatted[0].reason).toMatch(/secret/);
    const r = await postGithubChange({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: keys.pkcs8 }, dirty, ctx, { fetch: fetchImpl });
    expect(r.posted).toBe(false);
    expect(r.reason).toMatch(/secret/);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(formatted)).not.toContain("private board");
    expect(formatted.some((p) => JSON.stringify(p.body).includes("diff"))).toBe(false);
  });

  it("expands a 12-character sha through mocked GitHub HTTP, then POSTs the Check", async () => {
    const shortCard = parseCard({
      repo: "vmallela0/agent-soup",
      branch: "cursor/github-app",
      base: "main",
      pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
      ci: "passing",
      commits: [{ sha: "aaaaaaaaaaaa", title: "short sha" }],
    }).card;
    expect(shortCard.commits[0].sha).toHaveLength(12);
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub((url, method) => {
      if (method === "GET" && url.pathname.endsWith("/installation")) return { status: 200, json: { id: 99 } };
      if (method === "POST" && url.pathname.endsWith("/access_tokens")) return { status: 201, json: { token: "ghs_test_installation_token" } };
      if (method === "GET" && url.pathname.endsWith("/commits/aaaaaaaaaaaa")) {
        return { status: 200, json: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } };
      }
      if (method === "GET" && url.pathname.includes("/check-runs")) return { status: 200, json: { check_runs: [] } };
      if (method === "POST" && url.pathname.endsWith("/check-runs")) return { status: 201, json: { id: 501 } };
      if (method === "POST" && url.pathname.endsWith("/comments")) return { status: 201, json: { id: 77 } };
      return { status: 404, json: { message: "unexpected " + method + " " + url.pathname } };
    }, calls);

    const r = await postGithubChange({ GITHUB_APP_ID: "4242", GITHUB_APP_PRIVATE_KEY: keys.pkcs8 }, shortCard, { seq: ctx.seq, author: ctx.author, boardId: ctx.boardId, boardUrl: ctx.boardUrl }, { fetch: fetchImpl });
    expect(r.posted).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/commits/aaaaaaaaaaaa"))).toBe(true);
    const check = calls.find((c) => c.method === "POST" && c.url.endsWith("/check-runs"))?.body as { head_sha: string; output: { summary: string } };
    expect(check.head_sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(check.output.summary).toContain("Change card #12 by vedu");
    expect(check.output.summary).toContain(ctx.boardUrl);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/diff --git|BEGIN |ghs_test/);
  });
});

describe("live change-card hook", () => {
  it("builds only seq, author, and board URL", () => {
    expect(githubChangeCtx({ seq: 12, author: "vedu", boardId: "b_skyvcqtm7fei", publicUrl: "https://atteo.dev/" })).toEqual({
      seq: 12,
      author: "vedu",
      boardId: "b_skyvcqtm7fei",
      boardUrl: "https://atteo.dev/b/b_skyvcqtm7fei#e12",
    });
  });

  it("returns posted:false with no fetch when App credentials are unset", async () => {
    const { card } = parseCard({
      repo: "vmallela0/agent-soup",
      branch: "cursor/github-app",
      pr_url: "https://github.com/vmallela0/agent-soup/pull/44",
      ci: "passing",
      commits: [{ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "hook" }],
    });
    const calls: GhCall[] = [];
    const fetchImpl = mockGithub(() => {
      throw new Error("fetch must not run");
    }, calls);
    const r = await notifyGithubChangeCard({}, card, { seq: 12, author: "vedu", boardId: "b_skyvcqtm7fei" }, { fetch: fetchImpl });
    expect(r.posted).toBe(false);
    expect(r.reason).toContain("aren't set");
    expect(calls).toHaveLength(0);
    expect(r.payloads[0].body).toMatchObject({ details_url: "https://agent-board.vedu-mallela.workers.dev/b/b_skyvcqtm7fei#e12" });
  });
});
