// Atteo Workspaces P0 spike (#1409): one board's workspace as a Durable Object with a Container, run locally with
// `wrangler dev`. It measures wake time, what survives sleep, and egress/secrets control. Never deployed; no auth.
//
//   POST /ws/:board/exec      {argv, cwd?}            run a command (starts the container if it's asleep)
//   POST /ws/:board/sleep     {mode}                  "plain" (destroy), "snapshot" (container snapshot, then destroy),
//                                                     "backup" (DirectoryBackup of /workspace to R2, then destroy)
//   PUT  /ws/:board/rules     {allow, secrets}        egress allowlist; secrets: {host: token} added by the Worker
//   GET  /ws/:board/state
import { DirectoryBackup, type DirectoryBackupGatewayBinding, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export { DirectoryBackupGateway } from "@cloudflare/sandbox";

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// exec() doesn't inherit start()'s env: every HTTPS-making command needs the interception CA.
const TRUST = { CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA, NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, npm_config_cafile: CA, HOME: "/root" };

interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  BACKUPS: R2Bucket;
}
interface Rules {
  allow: string[];
  secrets: Record<string, string>; // host → bearer token, added outside the container
}
interface WakeState {
  mode: "fresh" | "plain" | "snapshot" | "backup";
  snapshot?: string;
  backup?: DirectoryBackupRecord;
}
type State = DurableObjectState & { readonly exports: Cloudflare.Exports & { readonly Egress: LoopbackForExport<typeof Egress>; readonly DirectoryBackupGateway: DirectoryBackupGatewayBinding } };

const match = (host: string, pat: string) => (pat.startsWith("*.") ? host.endsWith(pat.slice(1)) : host === pat || pat === "*");

// Every HTTP/HTTPS request the container makes lands here: allowlisted hosts go out, secrets are added here, the rest
// is refused. Nothing else leaves (enableInternet: false).
export class Egress extends WorkerEntrypoint<Env, { board: string }> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rules = await this.env.WORKSPACE.getByName(this.ctx.props.board).rules();
    const token = Object.entries(rules.secrets).find(([h]) => match(url.hostname, h))?.[1];
    if (token) {
      if (url.protocol !== "https:") return new Response("secrets go over HTTPS only\n", { status: 403 });
      const h = new Headers(request.headers);
      h.set("authorization", `Bearer ${token}`);
      return fetch(new Request(request, { headers: h }));
    }
    if (rules.allow.some((p) => match(url.hostname, p))) return fetch(request);
    return new Response(`${url.hostname} is not on this workspace's allowlist\n`, { status: 403 });
  }
}

export class Workspace extends DurableObject<Env> {
  readonly #c: Container;
  readonly #x: State["exports"];
  readonly #backups: DirectoryBackup;

  constructor(ctx: State, env: Env) {
    super(ctx, env);
    if (!ctx.container) throw new Error("no container binding");
    this.#c = ctx.container;
    this.#x = ctx.exports;
    this.#backups = new DirectoryBackup(this.#c, ctx.exports.DirectoryBackupGateway, { binding: "BACKUPS", prefix: "ws/" });
  }

  rules(): Rules {
    return { allow: [], secrets: {}, ...(this.ctx.storage.kv.get<Rules>("rules") ?? {}) };
  }
  setRules(r: Partial<Rules>): Rules {
    const next = { ...this.rules(), ...r };
    this.ctx.storage.kv.put("rules", next);
    return next;
  }
  state() {
    return { running: this.#c.running, wake: this.ctx.storage.kv.get<WakeState>("wake") ?? { mode: "fresh" } };
  }

  /** Starts the container if it's asleep, the way the last sleep left it; returns the ms each step took. */
  async #wake(board: string): Promise<Record<string, number> | null> {
    if (this.#c.running) return null;
    const w = this.ctx.storage.kv.get<WakeState>("wake") ?? { mode: "fresh" };
    const t: Record<string, number> = {};
    let t0 = Date.now();
    const base = { enableInternet: false, labels: { board } } as const;
    if (w.mode === "snapshot" && w.snapshot) this.#c.start({ ...base, containerSnapshot: { id: w.snapshot } });
    else this.#c.start({ ...base, image: this.#c.images.sandbox });
    const step = async (name: string, f: () => Promise<unknown>) => {
      const s = Date.now();
      await f();
      t[name] = Date.now() - s;
    };
    // Only HTTP(S) leaves, and only through Egress (allowlist + secrets); the rules can change while it runs.
    const egress = this.#x.Egress({ props: { board } });
    await step("interceptHttp", () => this.#c.interceptAllOutboundHttp(egress));
    await step("interceptHttps", () => this.#c.interceptOutboundHttps("*", egress));
    // Code running inside doesn't count as activity: a request (or an alarm) has to keep the object busy.
    await step("inactivity", () => this.#c.setInactivityTimeout(30 * 60_000));
    // The first exec that succeeds is when the container is really up.
    await step("firstExec", async () => {
      for (let i = 0; ; i++) {
        try {
          return await (await this.#c.exec(["true"])).output();
        } catch (e) {
          if (i > 120 || !/not running/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    });
    t.start = Date.now() - t0;
    if (w.mode === "backup" && w.backup) {
      t0 = Date.now();
      await this.#backups.restore(w.backup);
      t.restore = Date.now() - t0;
    }
    return t;
  }

  async exec(board: string, argv: string[], cwd = "/workspace") {
    const t0 = Date.now();
    const woke = await this.#wake(board);
    const t1 = Date.now();
    const p = await this.#c.exec(argv, { cwd, env: TRUST });
    const out = await p.output();
    const dec = new TextDecoder();
    return { exitCode: out.exitCode, stdout: dec.decode(out.stdout).slice(-4000), stderr: dec.decode(out.stderr).slice(-4000), woke, wakeMs: t1 - t0, execMs: Date.now() - t1 };
  }

  async sleep(mode: "plain" | "snapshot" | "backup", exclude: string[] = []) {
    const t0 = Date.now();
    let w: WakeState = { mode: "plain" };
    if (this.#c.running && mode === "snapshot") {
      const s = await this.#c.snapshotContainer({ name: `ws-${Date.now()}` });
      w = { mode, snapshot: s.id };
    } else if (this.#c.running && mode === "backup") {
      const b = await this.#backups.backup({ dir: "/workspace", exclude });
      w = { mode, backup: b };
    }
    const saveMs = Date.now() - t0;
    if (this.#c.running) await this.#c.destroy();
    this.ctx.storage.kv.put("wake", w);
    return { mode, saveMs, totalMs: Date.now() - t0, size: w.backup?.size ?? null, snapshot: w.snapshot ?? null };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const m = /^\/ws\/([a-z0-9-]{1,63})\/(exec|sleep|rules|state)$/.exec(new URL(request.url).pathname);
    if (!m) return new Response("not found", { status: 404 });
    const ws = env.WORKSPACE.getByName(m[1]);
    const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    try {
      if (m[2] === "exec") return Response.json(await ws.exec(m[1], body.argv as string[], (body.cwd as string) ?? undefined));
      if (m[2] === "sleep") return Response.json(await ws.sleep((body.mode as "plain") ?? "plain", (body.exclude as string[]) ?? []));
      if (m[2] === "rules") return Response.json(request.method === "PUT" ? await ws.setRules(body as Partial<Rules>) : await ws.rules());
      return Response.json(await ws.state());
    } catch (e) {
      return Response.json({ error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
