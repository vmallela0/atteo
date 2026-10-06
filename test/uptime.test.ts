import { describe, expect, it } from "vitest";
import { CSP_ENFORCE } from "../src/ui";
import { deepChecks, handlePublicStatus, publicStatus, type StatusEnv } from "../src/uptime";

const LEAK = "token sk-secret board b_healthcheck0 user alice@example.com ADMIN_KEY r2-key AKIASECRET";

function db(first: () => Promise<unknown> = async () => ({ x: 1 }), sql?: string[]) {
  return {
    prepare(query: string) {
      sql?.push(query);
      return { first };
    },
  };
}

function boards(info: () => unknown, names?: string[]): StatusEnv["BOARD"] {
  return {
    idFromName(name: string) {
      names?.push(name);
      return name;
    },
    get() {
      return { info };
    },
  };
}

function healthy(extra: Partial<StatusEnv> = {}): StatusEnv {
  return {
    DB: db(),
    BOARD: boards(() => {
      throw new Error("Board not found.");
    }),
    ...extra,
  };
}

const secretEnv = (): StatusEnv & { SENTRY_DSN: string; ADMIN_KEY: string } => ({
  ...healthy({
    DB: db(async () => {
      throw new Error(LEAK);
    }),
    BOARD: boards(() => {
      throw new Error(`Durable Object overloaded ${LEAK}`);
    }),
    FILES: {
      head: async () => {
        throw new Error(`AccessDenied ${LEAK}`);
      },
    },
  }),
  SENTRY_DSN: "https://secret@sentry.example/1",
  ADMIN_KEY: "admin-secret",
});

describe("public /status", () => {
  it("keeps CSP_ENFORCE off", () => {
    expect(CSP_ENFORCE).toBe(false);
  });

  it("reports ok when D1 and the Durable Object answer and no R2 binding is set", async () => {
    const queries: string[] = [];
    const names: string[] = [];
    const env: StatusEnv = {
      DB: db(async () => ({ x: 1 }), queries),
      BOARD: boards(() => {
        throw new Error("Board not found.");
      }, names),
    };
    const res = await handlePublicStatus(new Request("https://atteo.dev/status.json"), env, "/status.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", checks: { worker: "ok", database: "ok", boards: "ok" } });
    expect(queries).toEqual(["SELECT 1 AS x"]);
    expect(names).toEqual(["b_healthcheck0"]);
    expect(JSON.stringify(body)).not.toContain("b_healthcheck0");
  });

  it("marks files down as degraded, and a core failure as down", async () => {
    const degradedEnv = healthy({
      FILES: {
        head: async () => {
          throw new Error(LEAK);
        },
      },
    });
    const degraded = await handlePublicStatus(new Request("https://atteo.dev/status.json"), degradedEnv, "/status.json");
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toEqual({ status: "degraded", checks: { worker: "ok", database: "ok", boards: "ok", files: "down" } });

    const filesOk = await publicStatus(healthy({ FILES: { head: async () => null } }));
    expect(filesOk).toEqual({ status: "ok", checks: { worker: "ok", database: "ok", boards: "ok", files: "ok" } });

    const down = await publicStatus(
      healthy({
        DB: db(async () => {
          throw new Error("D1 unavailable");
        }),
      }),
    );
    expect(down.status).toBe("down");
    expect(down.checks.database).toBe("down");
    expect(down.checks.files).toBeUndefined();
    expect(JSON.stringify(down)).not.toContain("D1 unavailable");
  });

  it("does not put secrets, board ids, tokens, or error text on the public response", async () => {
    const env = secretEnv();
    for (const path of ["/status", "/status.json"]) {
      const res = await handlePublicStatus(new Request(`https://atteo.dev${path}`, { headers: { accept: "application/json" } }), env, path);
      expect(res.status).toBe(503);
      const text = await res.text();
      const body = JSON.parse(text) as { status: string; checks: Record<string, string> };
      expect(body.status).toBe("down");
      expect(body.checks).toEqual({ worker: "ok", database: "down", boards: "down", files: "down" });
      for (const secret of ["sk-secret", "b_healthcheck0", "alice@example.com", "ADMIN_KEY", "AKIASECRET", "admin-secret", "sentry.example", "_atteo/status-probe", "AccessDenied", "overloaded"]) {
        expect(text, secret).not.toContain(secret);
      }
    }
  });

  it("serves HTML by default and JSON when asked", async () => {
    const env = healthy();
    const html = await handlePublicStatus(new Request("https://atteo.dev/status", { headers: { accept: "text/html,application/xhtml+xml" } }), env, "/status");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toMatch(/text\/html/);
    expect(html.headers.get("content-security-policy")).toBeNull();
    expect(html.headers.get("content-security-policy-report-only")).toContain("script-src");
    expect(html.headers.get("cache-control")).toBe("no-store");
    const page = await html.text();
    expect(page).toContain('id="atteo-status" data-status="ok"');
    expect(page).toContain("status: ok");
    expect(page).toContain("database: ok");
    expect(page).toContain("boards: ok");
    expect(page).not.toContain("files:");
    expect(page).not.toContain("b_healthcheck0");

    const degraded = await handlePublicStatus(
      new Request("https://atteo.dev/status"),
      healthy({ FILES: { head: async () => { throw new Error("nope"); } } }),
      "/status",
    );
    expect(degraded.status).toBe(503);
    const degradedHtml = await degraded.text();
    expect(degradedHtml).toContain("status: degraded");
    expect(degradedHtml).toContain("files: down");
    expect(degradedHtml).not.toContain("status: ok");

    const explicit = await handlePublicStatus(new Request("https://atteo.dev/status?format=json", { headers: { accept: "text/html" } }), env, "/status");
    expect(explicit.headers.get("content-type")).toMatch(/application\/json/);
    expect(await explicit.json()).toMatchObject({ status: "ok" });

    const both = await handlePublicStatus(new Request("https://atteo.dev/status", { headers: { accept: "application/json, text/html" } }), env, "/status");
    expect(both.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("answers HEAD with the same status and no body, and refuses other methods before probing", async () => {
    const env = healthy();
    const head = await handlePublicStatus(new Request("https://atteo.dev/status", { method: "HEAD" }), env, "/status");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toMatch(/text\/html/);

    let probed = false;
    const closed: StatusEnv = {
      DB: db(async () => {
        probed = true;
        return null;
      }),
      BOARD: boards(() => {
        probed = true;
      }),
    };
    const post = await handlePublicStatus(new Request("https://atteo.dev/status", { method: "POST" }), closed, "/status");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect(probed).toBe(false);
    expect(await post.json()).toEqual({ error: "Method not allowed" });
  });

  it("keeps /health/deep error detail out of the public report", async () => {
    const env = healthy({
      DB: db(async () => {
        throw new Error(`token=secret ${"x".repeat(400)}`);
      }),
    });
    const deep = await deepChecks(env);
    expect(deep.database.length).toBe(200);
    expect(deep.database).toContain("token=secret");
    expect(deep.boards).toBe("ok");
    const pub = await publicStatus(env);
    expect(pub.checks.database).toBe("down");
    expect(JSON.stringify(pub)).not.toContain("token=secret");
    expect(JSON.stringify(pub)).not.toContain("xxx");
  });
});
