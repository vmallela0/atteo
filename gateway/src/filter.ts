// Inspect a write before it leaves this machine. Same gitleaks-style rules as the Worker
// (`src/secrets.ts`); never returns or logs the matched value.

import { blockedMessage, scanFields, type SecretHit } from "../../src/secrets";

export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

export function blockedLocally(hit: SecretHit): string {
  return blockedMessage(hit) + " (Caught on this machine; nothing was sent.)";
}

function collectStrings(value: unknown, fields: Record<string, string>, key: string) {
  if (value == null) return;
  if (typeof value === "string") {
    if (value) fields[key || "body"] = value;
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, fields, key ? `${key}.${i}` : String(i)));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(v, fields, key ? `${key}.${k}` : k);
    }
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const t = body.trim();
  if (!t) return "";
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return body;
    }
  }
  return body;
}

/** First secret in a write's body, or null. Headers are never scanned (the session token would match). */
export function inspectWrite(req: { method?: string; body?: unknown }): SecretHit | null {
  if (!isWriteMethod(req.method ?? "GET")) return null;
  if (req.body == null || req.body === "") return null;
  const parsed = parseBody(req.body);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    if (o.method === "tools/call" && o.params && typeof o.params === "object") {
      const args = (o.params as { arguments?: unknown }).arguments;
      if (args && typeof args === "object") {
        const hit = scanFields(
          Object.fromEntries(
            Object.entries(args as Record<string, unknown>)
              .filter(([, v]) => v != null)
              .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
          ),
        );
        if (hit) return hit;
      }
    }
  }
  const fields: Record<string, string> = {};
  collectStrings(parsed, fields, "");
  return scanFields(fields);
}
