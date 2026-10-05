import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FORBIDDEN_VARS,
  OPTIONAL_SECRETS,
  REQUIRED_SECRETS,
  REQUIRED_VARS,
  envKeysFromTypes,
  fileChecks,
  named,
  parseArgs,
  parseJsonc,
  reportJson,
  staticChecks,
  summarize,
} from "../scripts/self-host-check.mjs";

const wrangler = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const envKeys = envKeysFromTypes(readFileSync("src/types.ts", "utf8"));
const selfHost = readFileSync("docs/SELF_HOST.md", "utf8");

function treeFrom(root = ".") {
  const read = (p) => readFileSync(join(root, p), "utf8");
  return {
    wrangler: parseJsonc(read("wrangler.jsonc")),
    envKeys: envKeysFromTypes(read("src/types.ts")),
    selfHost: read("docs/SELF_HOST.md"),
    appApi: read("docs/APP_API.md"),
    backups: read("docs/BACKUPS.md"),
    gitignore: read(".gitignore"),
    cliMain: read("cli/src/main.ts"),
    migrations: readdirSync(join(root, "migrations")).filter((n) => /^\d+_.*\.sql$/.test(n)).sort(),
  };
}

describe("self-host-check parseJsonc", () => {
  it("keeps https:// inside strings and drops // and /* */ comments", () => {
    const j = parseJsonc(`{
      // line comment
      "url": "https://atteo.dev", /* block */
      "name": "agent-board" // trailing
    }`);
    expect(j).toEqual({ url: "https://atteo.dev", name: "agent-board" });
  });

  it("parses the committed wrangler.jsonc", () => {
    expect(wrangler.name).toBe("agent-board");
    expect(wrangler.d1_databases[0].migrations_dir).toBe("migrations");
    expect(wrangler.vars.PUBLIC_URL).toBe("https://atteo.dev");
  });
});

describe("self-host-check Env keys", () => {
  it("classifies secrets, vars, and local-only flags from src/types.ts", () => {
    for (const n of REQUIRED_SECRETS) expect(envKeys.secrets, n).toContain(n);
    for (const n of REQUIRED_VARS) expect(envKeys.vars, n).toContain(n);
    for (const n of OPTIONAL_SECRETS) expect(envKeys.secrets, n).toContain(n);
    expect(envKeys.local).toEqual(expect.arrayContaining(["DEV_FAKE_MAGIC", "DEV_FAKE_CLOCK", "DEV_FAKE_VOICE", "ALLOW_LOCAL_WEBHOOKS"]));
    expect(envKeys.secrets).not.toContain("WORKOS_CLIENT_ID");
    expect(envKeys.vars).not.toContain("WORKOS_API_KEY");
  });
});

describe("self-host-check the committed tree", () => {
  it("passes every docs/config check (no wrangler spawn)", () => {
    const checks = [...staticChecks(treeFrom(".")), ...fileChecks(".")];
    expect(checks.filter((c) => c.status === "fail"), JSON.stringify(checks.filter((c) => c.status === "fail"), null, 2)).toEqual([]);
    expect(summarize(checks).ok).toBeGreaterThan(8);
  });

  it("CI runs the checker, and the recipe names it", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toContain("scripts/self-host-check.mjs");
    expect(selfHost).toContain("scripts/self-host-check.mjs");
    expect(named(selfHost, "WORKOS_CLIENT_ID")).toBe(true);
  });
});

describe("self-host-check negatives", () => {
  it("fails wrangler.jsonc vars that leak DEV_* or secrets", () => {
    const tree = treeFrom(".");
    tree.wrangler = {
      ...tree.wrangler,
      vars: { ...tree.wrangler.vars, DEV_FAKE_MAGIC: "1", WORKOS_API_KEY: "sk_test_x" },
    };
    const leaked = staticChecks(tree).find((c) => c.id === "wrangler-vars");
    expect(leaked.status).toBe("fail");
    expect(leaked.detail).toMatch(/DEV_FAKE_MAGIC/);
    expect(leaked.detail).toMatch(/WORKOS_API_KEY/);
  });

  it("fails SELF_HOST.md that drops a required var", () => {
    const tree = treeFrom(".");
    tree.selfHost = tree.selfHost.replaceAll("WORKOS_CLIENT_ID", "WORKOS_CLIENT");
    const req = staticChecks(tree).find((c) => c.id === "docs-required");
    expect(req.status).toBe("fail");
    expect(req.detail).toMatch(/WORKOS_CLIENT_ID/);
  });

  it("fails a D1 block without a UUID database_id or migrations_dir", () => {
    const tree = treeFrom(".");
    tree.wrangler = {
      ...tree.wrangler,
      d1_databases: [{ binding: "DB", database_name: "agent-board", database_id: "replace-me", migrations_dir: "db" }],
    };
    const shape = staticChecks(tree).find((c) => c.id === "wrangler-shape");
    expect(shape.status).toBe("fail");
    expect(shape.detail).toMatch(/UUID/);
    expect(shape.detail).toMatch(/migrations_dir/);
  });

  it("forbidden production flags match the Env local-only names we care about", () => {
    for (const n of ["DEV_FAKE_MAGIC", "DEV_FAKE_CLOCK", "DEV_FAKE_VOICE", "ALLOW_LOCAL_WEBHOOKS", "BACKUP_RESTORE"]) {
      expect(FORBIDDEN_VARS).toContain(n);
    }
  });
});

describe("self-host-check parseArgs", () => {
  it("reads flags", () => {
    expect(parseArgs(["--json", "--skip-wrangler", "--base", "https://board.example"])).toMatchObject({
      json: true,
      skipWrangler: true,
      base: "https://board.example",
    });
  });
});

describe("self-host-check reportJson", () => {
  it("uses ok as a boolean, not the pass count", () => {
    const j = reportJson([
      { id: "a", status: "ok", detail: "x" },
      { id: "b", status: "skip", detail: "y" },
    ]);
    expect(j.ok).toBe(true);
    expect(j.okCount).toBe(1);
    expect(j.skipped).toBe(1);
    expect(j.failed).toBe(0);
    expect(reportJson([{ id: "a", status: "fail", detail: "no" }]).ok).toBe(false);
  });
});

describe("self-host-check fileChecks", () => {
  it("fails when a recipe script is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "atteo-selfhost-files-"));
    try {
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "stripe-setup.sh"), "");
      const c = fileChecks(dir)[0];
      expect(c.status).toBe("fail");
      expect(c.detail).toMatch(/cleanup-e2e\.sh/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
