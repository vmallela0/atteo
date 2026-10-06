// Harness action policy (GAPS P0 #2 / #7). Side-effecting actions — shell, file writes,
// and other harness tool calls — are denied unless an allow rule matches. Deny rules win.
// Hosted HTTP writes stay allowed unless a deny rule says otherwise, so the secret filter
// on gatewayFetch is unchanged when no rule targets them.
//
// This does not tunnel MCP, and it does not read path prefixes from a room charter.
// Shell rules match the whole command, exactly: a prefix would allow `npm test && …`.

import { blockedMessage, scanFields, type SecretHit } from "../../src/secrets";

export type ActionKind = "http_write" | "shell" | "file_write" | "mcp_tool";

export const SIDE_EFFECT_KINDS = ["shell", "file_write", "mcp_tool"] as const satisfies readonly ActionKind[];

const SIDE_EFFECTS = new Set<ActionKind>(SIDE_EFFECT_KINDS);

export interface ActionRequest {
  kind: ActionKind;
  method?: string;
  url?: string;
  /** Harness shell command. Matched exactly, after trimming surrounding whitespace. */
  command?: string;
  /** Path on disk. Confined lexically to an allow rule's pathPrefix (no symlink resolution). */
  path?: string;
  /** Harness working directory, used to resolve a relative path. */
  cwd?: string;
  tool?: string;
  /** File contents or other payload text. Scanned for secrets; never matched as a rule. */
  content?: string;
}

export interface ActionDecision {
  allow: boolean;
  reason?: string;
}

export interface ActionPolicy {
  allow(action: ActionRequest): ActionDecision | Promise<ActionDecision>;
}

/** No harness rules. Fetch uses this so hosted writes are not denied by default. */
export const allowAll: ActionPolicy = {
  allow: () => ({ allow: true }),
};

export interface ActionRule {
  kind: ActionKind;
  /** Tool name, compared case-insensitively (Bash, Edit, …). */
  tool?: string;
  /** Shell: the full command. */
  command?: string;
  /** file_write: absolute directory the path must stay inside. */
  pathPrefix?: string;
  /** http_write: HTTP method. */
  method?: string;
  /** http_write: URL prefix, bounded so `https://evil.example` does not match `https://evil.example.attacker`. */
  urlPrefix?: string;
}

export interface HarnessPolicySpec {
  allow?: ActionRule[];
  deny?: ActionRule[];
}

const RULE_FIELDS: Record<ActionKind, readonly (keyof ActionRule)[]> = {
  shell: ["tool", "command"],
  file_write: ["tool", "pathPrefix"],
  mcp_tool: ["tool"],
  http_write: ["tool", "method", "urlPrefix"],
};

const KINDS = new Set<string>(["http_write", "shell", "file_write", "mcp_tool"]);

export class ActionPolicyError extends Error {
  readonly code = "GATEWAY_POLICY";
  constructor(message: string) {
    super(message);
    this.name = "ActionPolicyError";
  }
}

export interface HarnessHookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface HarnessReview {
  /** No policy, or the tool is not a side effect (a local read). The caller decides what to do. */
  effect: "skip" | "ask" | "deny";
  reason?: string;
}

const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "terminal", "exec"]);
// PR 77: a patch can name several destinations; it needs an explicit tool allow rule.
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "strreplace", "delete"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "ls", "list", "listdir"]);

function invalid(detail: string): { ok: false; reason: string } {
  return { ok: false, reason: `Blocked by action policy: ${detail} Nothing was run.` };
}

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/** Lexical normal form with forward slashes. `..` is resolved; this does not touch the filesystem. */
function normalizePath(p: string): string {
  // PR 77: backslashes are filename characters on POSIX, not directory boundaries.
  const slash = /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/") : p;
  const drive = /^([A-Za-z]:)(\/|$)/.exec(slash);
  const absolute = slash.startsWith("/") || !!drive;
  const body = drive ? slash.slice(drive[1].length) : slash;
  const out: string[] = [];
  for (const seg of body.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (drive) return `${drive[1].toUpperCase()}/${out.join("/").toLowerCase()}`;
  if (absolute) return `/${out.join("/")}`;
  return out.join("/");
}

function isFsRoot(p: string): boolean {
  return p === "/" || /^[A-Z]:\/$/.test(p);
}

function joinUnder(cwd: string, rel: string): string {
  if (isAbs(rel)) return rel;
  return `${cwd.replace(/\/+$/, "")}/${rel}`;
}

function ambiguousWindowsPath(path: string, cwd = ""): boolean {
  return path.startsWith("\\") || /^[A-Za-z]:(?![\\/])/.test(path)
    || [path, cwd].some((p) => p.split(/[\\/]/).some((s) => s !== "." && s !== ".." && /[ .]$/.test(s)));
}

function insidePrefix(prefix: string, candidate: string, cwd?: string): boolean {
  if (candidate.includes("\0") || (cwd ?? "").includes("\0")) return false;
  const root = normalizePath(prefix);
  if (!isAbs(root) || isFsRoot(root)) return false;
  // PR 77: Windows root/drive-relative paths and trailing-dot aliases are ambiguous.
  if (/^[A-Z]:\//.test(root) && ambiguousWindowsPath(candidate, cwd)) return false;
  const raw = !isAbs(candidate) && cwd && isAbs(cwd) ? joinUnder(cwd, candidate) : candidate;
  const target = normalizePath(raw);
  if (!isAbs(target)) return false;
  return target === root || target.startsWith(`${root}/`);
}

function urlMatches(prefix: string, url: string): boolean {
  if (!url.startsWith(prefix)) return false;
  if (url.length === prefix.length || prefix.endsWith("/")) return true;
  const next = url[prefix.length];
  return next === "/" || next === "?" || next === "#";
}

function matches(rule: ActionRule, action: ActionRequest): boolean {
  if (rule.kind !== action.kind) return false;
  if (rule.tool != null && rule.tool.toLowerCase() !== (action.tool ?? "").toLowerCase()) return false;
  if (rule.command != null && rule.command !== (action.command ?? "").trim()) return false;
  if (rule.method != null && rule.method !== (action.method ?? "").toUpperCase()) return false;
  if (rule.urlPrefix != null && !urlMatches(rule.urlPrefix, action.url ?? "")) return false;
  if (rule.pathPrefix != null && (action.path == null || !insidePrefix(rule.pathPrefix, action.path, action.cwd))) return false;
  return true;
}

function toolLabel(tool: string | undefined): string {
  if (!tool) return "";
  const one = tool.replace(/[\r\n\0]/g, " ").trim();
  if (!one) return "";
  const short = one.length > 40 ? `${one.slice(0, 40)}…` : one;
  return ` (${short})`;
}

function refusal(action: ActionRequest, why: string): ActionDecision {
  const stopped = action.kind === "http_write" ? "Nothing was sent." : "Nothing was run.";
  return { allow: false, reason: `Blocked by action policy: ${action.kind}${toolLabel(action.tool)} ${why} ${stopped}` };
}

function blockedAction(hit: SecretHit): string {
  return blockedMessage(hit) + " (Caught on this machine; nothing was run.)";
}

function compile(spec: HarnessPolicySpec): ActionPolicy {
  const allow = spec.allow ?? [];
  const deny = spec.deny ?? [];
  const windowsPaths = [...allow, ...deny].some((rule) => /^[A-Z]:\//.test(rule.pathPrefix ?? ""));
  return {
    allow(action) {
      const hit = scanFields({
        command: action.command,
        path: action.path,
        content: action.content,
        tool: action.tool,
        url: action.url,
      });
      if (hit) return { allow: false, reason: blockedAction(hit) };
      // PR 77: an ambiguous path must not bypass a deny rule under a broad allow.
      if (action.kind === "file_write" && action.path && (windowsPaths || /^[A-Za-z]:/.test(action.path) || /^[A-Za-z]:/.test(action.cwd ?? ""))
        && ambiguousWindowsPath(action.path, action.cwd)) return refusal(action, "has an ambiguous Windows path.");
      if (deny.some((rule) => matches(rule, action))) return refusal(action, "matches a deny rule.");
      if (SIDE_EFFECTS.has(action.kind)) {
        if (allow.some((rule) => matches(rule, action))) return { allow: true };
        return refusal(action, "is not on the allowlist.");
      }
      return { allow: true };
    },
  };
}

function parseRule(rule: unknown, where: string): ActionRule | { ok: false; reason: string } {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return invalid(`${where} must be an object.`);
  const raw = rule as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !KINDS.has(raw.kind)) {
    return invalid(`${where} needs a kind (http_write, shell, file_write, or mcp_tool).`);
  }
  const kind = raw.kind as ActionKind;
  const out: ActionRule = { kind };
  const allowed = new Set<string>(RULE_FIELDS[kind]);
  for (const [key, value] of Object.entries(raw)) {
    if (key === "kind") continue;
    if (!allowed.has(key)) return invalid(`${where} uses "${key}", which does not apply to ${kind}.`);
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      return invalid(`${where} ${key} must be a non-empty string.`);
    }
    if (key === "method") out.method = value.trim().toUpperCase();
    else if (key === "tool") out.tool = value.trim();
    else if (key === "command") out.command = value.trim();
    else if (key === "pathPrefix") out.pathPrefix = value.trim();
    else if (key === "urlPrefix") out.urlPrefix = value.trim();
  }
  if (out.pathPrefix) {
    if (!isAbs(out.pathPrefix)) return invalid(`${where} pathPrefix must be an absolute path.`);
    const norm = normalizePath(out.pathPrefix);
    if (isFsRoot(norm)) return invalid(`${where} pathPrefix must be a directory below the filesystem root.`);
    out.pathPrefix = norm;
  }
  return out;
}

function parseRuleList(value: unknown, label: string): ActionRule[] | { ok: false; reason: string } {
  if (value == null) return [];
  if (!Array.isArray(value)) return invalid(`${label} must be a list of rules.`);
  const rules: ActionRule[] = [];
  for (let i = 0; i < value.length; i++) {
    const rule = parseRule(value[i], `${label} rule ${i + 1}`);
    if ("ok" in rule) return rule;
    rules.push(rule);
  }
  return rules;
}

/** Validate a policy document. A bad document fails closed: nothing in it is enforced as an allow. */
export function parseHarnessPolicy(input: unknown): { ok: true; spec: HarnessPolicySpec } | { ok: false; reason: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("the policy must be a JSON object.");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "allow" && key !== "deny") return invalid(`unknown policy field "${key}".`);
  }
  const allow = parseRuleList(raw.allow, "allow");
  if (!Array.isArray(allow)) return allow;
  const deny = parseRuleList(raw.deny, "deny");
  if (!Array.isArray(deny)) return deny;
  return { ok: true, spec: { allow, deny } };
}

export function policyFromJson(text: string): { ok: true; policy: ActionPolicy } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid("the policy is not valid JSON.");
  }
  const parsed = parseHarnessPolicy(value);
  if (!parsed.ok) return parsed;
  return { ok: true, policy: compile(parsed.spec) };
}

/** Deny-by-default for shell, file_write, and mcp_tool. http_write is allowed unless a deny rule matches. */
export function harnessPolicy(spec: HarnessPolicySpec = {}): ActionPolicy {
  const parsed = parseHarnessPolicy(spec);
  if (!parsed.ok) throw new ActionPolicyError(parsed.reason);
  return compile(parsed.spec);
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Every string in the tool input, so a secret in an unlisted field is still refused. */
function joinedContent(value: unknown): string | undefined {
  const parts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v) parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === "object") {
      for (const child of Object.values(v as Record<string, unknown>)) walk(child);
    }
  };
  walk(value);
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Map a harness permission-hook payload to an action. Local reads are not side effects and return null.
 * Anything else is side-effecting: unknown tools are mcp_tool, which a harness policy denies by default.
 */
export function actionFromHarness(input: HarnessHookInput): ActionRequest | null {
  const tool = String(input.tool_name ?? "").trim();
  const args = input.tool_input ?? {};
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : undefined;
  const command = typeof args.command === "string" ? args.command : undefined;
  const path = firstString(args, ["file_path", "path", "target_file", "notebook_path"]);
  const content = joinedContent(args);
  const key = tool.toLowerCase();
  if (!tool && command == null && path == null && content == null) return null;
  if (READ_TOOLS.has(key)) return null;
  const base = { tool: tool || undefined, cwd, content };
  // PR 77: argument names do not establish what an unknown tool does.
  if (SHELL_TOOLS.has(key)) {
    return { kind: "shell", ...base, tool: tool || "shell", command, path };
  }
  if (WRITE_TOOLS.has(key)) {
    return { kind: "file_write", ...base, tool: tool || "file_write", path, command };
  }
  return { kind: "mcp_tool", ...base, tool: tool || "mcp_tool", command, path };
}

/**
 * What a permission hook should do. `skip` means no policy is configured, or the tool is not a side effect.
 * `ask` means an allow rule matched — the person still decides. `deny` is local: do not run it and do not send it.
 */
export async function reviewHarnessHook(policy: ActionPolicy | null, input: HarnessHookInput): Promise<HarnessReview> {
  if (!policy) return { effect: "skip" };
  const action = actionFromHarness(input);
  if (!action) return { effect: "skip" };
  const decision = await policy.allow(action);
  if (!decision.allow) return { effect: "deny", reason: decision.reason ?? "Blocked by action policy. Nothing was run." };
  return { effect: "ask" };
}
