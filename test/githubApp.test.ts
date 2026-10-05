import { describe, expect, it } from "vitest";
import { parseCard } from "../src/card";
import {
  MAX_WEBHOOK_BYTES,
  NOT_SET_UP,
  boardNoteFromGithub,
  githubChangeNotification,
  handleWebhook,
  inboundEnabled,
  outboundEnabled,
  postGithubChange,
  prNumberFromUrl,
  verifySignature,
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

  it("builds a check-run and a PR comment, and stays a stub even with credentials", () => {
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

    expect(outboundEnabled({})).toBe(false);
    const skipped = postGithubChange({}, card, ctx);
    expect(skipped.posted).toBe(false);
    expect(skipped.reason).toContain("aren't set");
    const still = postGithubChange({ GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "not-a-real-key" }, card, { ...ctx, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(still.posted).toBe(false);
    expect(still.reason).toContain("isn't wired");
    expect(still.payloads[0].ready).toBe(true);
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
