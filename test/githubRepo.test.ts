import { beforeEach, describe, expect, it } from "vitest";
import { BOARD_JS, boardPage } from "../src/html";
import { boardGithubHttp, boardIdForRepo, normalizeRepo, parseRepoBoardMap } from "../src/githubRepo";
import type { BoardInfo, Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as {
  readFileSync: (u: URL, enc: string) => string;
  readdirSync: (u: URL) => string[];
};
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function positional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const used: unknown[] = [];
  const next = sql.replace(/\?(\d+)/g, (_m, n) => {
    used.push(args[Number(n) - 1]);
    return "?";
  });
  return { sql: next, args: used };
}

function fakeEnv(extra: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      const q = positional(sql, args);
      return db.prepare(q.sql).get(...q.args) ?? null;
    },
    all: async () => {
      const q = positional(sql, args);
      return { results: db.prepare(q.sql).all(...q.args) };
    },
    run: async () => {
      const q = positional(sql, args);
      const info = db.prepare(q.sql).run(...q.args);
      return { results: [], meta: { changes: info.changes ?? 0 } };
    },
  });
  const env = { ...extra, DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env;
  return { env, db };
}

const boardId = "b_aaaaaaaa";
const otherId = "b_bbbbbbbb";

function user(db: any, name: string) {
  db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`).run(name, `${name}@example.com`);
}
function board(db: any, id: string, by: string, kind: string | null = null) {
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity, kind) VALUES (?, ?, ?, 0, 0, ?)`).run(id, id, by, kind);
}
function member(db: any, id: string, name: string, role: "owner" | "contributor" | "viewer") {
  db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 0, 0, ?)`).run(id, name, role);
}

describe("repo → board map shape", () => {
  it("normalizes owner/name and parses the env map (pairs or JSON)", () => {
    expect(normalizeRepo("  Vedu/Atteo ")).toBe("vedu/atteo");
    expect(normalizeRepo("not a repo")).toBeNull();
    expect(normalizeRepo("acme/app ghp_abcdefghijklmnop")).toBeNull();
    const pairs = parseRepoBoardMap("vmallela0/atteo=b_skyvcqtm7fei, acme/app:b_abcdefgh12\n# skip\n");
    expect(pairs.get("vmallela0/atteo")).toBe("b_skyvcqtm7fei");
    expect(pairs.get("acme/app")).toBe("b_abcdefgh12");
    const json = parseRepoBoardMap('{"Vmallela0/Atteo":"b_skyvcqtm7fei"}');
    expect(json.get("vmallela0/atteo")).toBe("b_skyvcqtm7fei");
  });

  it("stores only repo, board, time, and an optional installation id", () => {
    const { db } = fakeEnv();
    const cols = db.prepare(`PRAGMA table_info(github_repo_boards)`).all() as { name: string }[];
    expect(cols.map((c) => c.name).sort()).toEqual(["board_id", "created_at", "installation_id", "repo"]);
  });
});

describe("board github link", () => {
  let env: Env;
  let db: any;
  beforeEach(() => {
    ({ env, db } = fakeEnv());
    user(db, "ada");
    user(db, "bea");
    user(db, "cy");
    board(db, boardId, "ada");
    board(db, otherId, "bea");
    member(db, boardId, "ada", "owner");
    member(db, boardId, "bea", "contributor");
    member(db, boardId, "cy", "viewer");
    member(db, otherId, "bea", "owner");
  });

  it("refuses a contributor and a viewer with 403 and writes nothing", async () => {
    for (const who of ["bea", "cy"]) {
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        const res = await boardGithubHttp(env, method, boardId, who, { repo: "acme/app", installation_id: 9 });
        expect(res.status, `${who} ${method}`).toBe(403);
        expect(res.body).toEqual({ error: "Only the board's owners can connect a repository." });
      }
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM github_repo_boards`).get().n).toBe(0);
  });

  it("lets the owner save and clear without GitHub App secrets", async () => {
    expect(env.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    const saved = await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "Acme/App", installation_id: "42" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ repo: "acme/app", installation_id: 42 });
    expect(await boardGithubHttp(env, "GET", boardId, "ada", {})).toEqual({ status: 200, body: { repo: "acme/app", installation_id: 42 } });
    const row = db.prepare(`SELECT repo, board_id, installation_id FROM github_repo_boards`).get();
    expect(row).toEqual({ repo: "acme/app", board_id: boardId, installation_id: 42 });
    expect(JSON.stringify(row)).not.toMatch(/token|PRIVATE KEY|ghp_/);
    const cleared = await boardGithubHttp(env, "DELETE", boardId, "ada", {});
    expect(cleared).toEqual({ status: 200, body: { repo: null, installation_id: null } });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM github_repo_boards`).get().n).toBe(0);
    const audit = db.prepare(`SELECT action, target, detail FROM audit WHERE board_id = ? ORDER BY id`).all(boardId);
    expect(audit).toEqual([
      { action: "github_linked", target: "acme/app", detail: "installation 42" },
      { action: "github_unlinked", target: "acme/app", detail: null },
    ]);
  });

  it("a creator whose role column is contributor can still connect the repository", async () => {
    db.prepare(`UPDATE members SET role = 'contributor' WHERE board_id = ? AND user = 'ada'`).run(boardId);
    const saved = await boardGithubHttp(env, "POST", boardId, "ada", { repo: "acme/app" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ repo: "acme/app", installation_id: null });
  });

  it("replaces the board's previous repository and refuses one already on another board", async () => {
    expect((await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "acme/one", installation_id: 1 })).status).toBe(200);
    expect((await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "acme/two" })).body).toEqual({ repo: "acme/two", installation_id: null });
    const left = db.prepare(`SELECT repo FROM github_repo_boards WHERE board_id = ?`).all(boardId);
    expect(left.map((r: { repo: string }) => r.repo)).toEqual(["acme/two"]);
    const clash = await boardGithubHttp(env, "PUT", otherId, "bea", { repo: "acme/two", installation_id: 7 });
    expect(clash.status).toBe(409);
    expect(db.prepare(`SELECT board_id, installation_id FROM github_repo_boards WHERE repo = 'acme/two'`).get()).toEqual({ board_id: boardId, installation_id: null });
  });

  it("rejects tokens and private keys and does not store them", async () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----";
    for (const body of [
      { repo: "acme/app", private_key: pem },
      { repo: "acme/app", token: "ghp_abcdefghijklmnop" },
      { repo: "acme/ghp_abcdefghijklmnop" },
      { repo: "acme/app", installation_id: pem },
    ]) {
      const res = await boardGithubHttp(env, "PUT", boardId, "ada", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM github_repo_boards`).get().n).toBe(0);
    expect((await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "nope" })).status).toBe(400);
  });

  it("hides a missing or deleted board and refuses a direct chat", async () => {
    expect((await boardGithubHttp(env, "GET", boardId, "nope", {})).status).toBe(404);
    db.prepare(`UPDATE boards SET deleted_at = 1 WHERE id = ?`).run(boardId);
    expect((await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "acme/app" })).status).toBe(404);
    db.prepare(`UPDATE boards SET deleted_at = NULL, kind = 'direct' WHERE id = ?`).run(boardId);
    expect((await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "acme/app" })).status).toBe(400);
  });

  it("env map wins for lookup; D1 is used when the var is unset", async () => {
    await boardGithubHttp(env, "PUT", boardId, "ada", { repo: "acme/app" });
    expect(await boardIdForRepo(env, "acme/app")).toBe(boardId);
    expect(await boardIdForRepo({ ...env, GITHUB_REPO_BOARDS: "acme/app=b_cccccccc" }, "acme/app")).toBe("b_cccccccc");
    expect(await boardIdForRepo({ DB: env.DB }, "missing/repo")).toBeNull();
  });
});

describe("connect UI", () => {
  const info: BoardInfo = { id: "b_test1234", title: "Checkout", created_by: "ada", created_at: 0, entry_count: 0, last_seq: 0 };
  const ada = { name: "ada", email: "ada@example.com", display_name: null, admin: false };
  const page = (name: string, role?: "owner" | "contributor" | "viewer", kind: string | null = null) =>
    boardPage({ ...ada, name }, [], info, [{ user: "ada", display_name: null, last_seen: 0, role: "owner" }, { user: name, display_name: null, last_seen: 0, role: role ?? "owner" }], [], [], undefined, undefined, [], { picture: null, kind });

  it("shows the access form and a quiet board-info line to the owner", async () => {
    const html = await page("ada").text();
    expect(html).toContain('id="acc-github"');
    expect(html).toContain('id="gh-side"');
    expect(html).toContain('id="gh-repo"');
    expect(html).toContain('id="gh-install"');
    expect(html).toContain('placeholder="owner/repo"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("private_key");
    expect(BOARD_JS).toContain("fetch('/api/boards/'+BOARD+'/github',{method:'PUT'");
    expect(BOARD_JS).toContain("fetch('/api/boards/'+BOARD+'/github',{method:'DELETE'");
  });

  it("hides the form from a contributor, a viewer, and on a direct board", async () => {
    for (const html of [await page("bea", "contributor").text(), await page("cy", "viewer").text(), await page("ada", "owner", "direct").text()]) {
      expect(html).not.toContain('id="acc-github"');
      expect(html).not.toContain('id="gh-repo"');
      expect(html).not.toContain('id="gh-side"');
    }
  });
});
