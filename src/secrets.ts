// Egress secret filter: credentials never get stored on a board.
// Pure (no I/O) so the same rules can run in the Worker today and in a local Gateway later.
// Precise, curated rules in the spirit of gitleaks; no bare high-entropy rule (it blocks logs full of hashes).

export interface SecretRule {
  id: string;
  label: string;
  re: RegExp;
}

export interface SecretHit {
  rule: string;
  label: string;
  field: string;
  line: number;
}

// Values that are clearly placeholders or references, not secrets.
const PLACEHOLDER =
  /^(?:\*{3,}|x{4,}|X{4,}|\.{3,}|<[^>]*>|\[[^\]]*\]|\{\{?[^}]*\}?\}|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_]+%|(?:process\.env|import\.meta\.env|os\.environ|env)\b|your[_-]|example|changeme|redacted|placeholder|dummy|sample|test123|password\b|secret\b|null\b|none\b|true\b|false\b|undefined\b)/i;

export const RULES: SecretRule[] = [
  { id: "private-key", label: "a private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", label: "an AWS access key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { id: "github-token", label: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: "slack-token", label: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b|https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{12,}/ },
  { id: "stripe-live-key", label: "a Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: "anthropic-key", label: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", label: "an OpenAI API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "google-api-key", label: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "workos-key", label: "a WorkOS API key", re: /\bsk_(?:test|live)_[A-Za-z0-9]{40,}\b/ },
  { id: "cloudflare-token", label: "a Cloudflare API token", re: /\bcfat_[A-Za-z0-9]{30,}\b/ },
  { id: "resend-key", label: "a Resend API key", re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}\b/ },
  { id: "agent-board-token", label: "an Agent Board access token", re: /\bab_[A-Za-z0-9_-]{40,}/ },
  { id: "jwt", label: "a signed token (JWT)", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/ },
  { id: "url-credentials", label: "a password inside a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{6,})@[^\s/]+/i },
];

// key = value, where the key names a secret and the value isn't a placeholder.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|bearer)[A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*["']?([^\s"',;)}]{8,})/gi;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** First secret found in `text`, or null. Never returns the matched value. */
export function scanText(text: string, field = "text"): SecretHit | null {
  if (!text) return null;
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    if (r.id === "url-credentials" && PLACEHOLDER.test(m[1])) continue;
    return { rule: r.id, label: r.label, field, line: lineOf(text, m.index) };
  }
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const value = m[2];
    if (PLACEHOLDER.test(value)) continue;
    // Credentials mix letters and digits; prose, identifiers, env-var names, code and paths usually don't.
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) continue;
    if (/[`(]/.test(value) || /^[A-Za-z]+\/[A-Za-z/]+$/.test(value)) continue;
    return { rule: "secret-assignment", label: `a value for "${m[1]}"`, field, line: lineOf(text, m.index) };
  }
  return null;
}

/** Checks several named fields; returns the first hit. */
export function scanFields(fields: Record<string, string | null | undefined>): SecretHit | null {
  for (const [field, value] of Object.entries(fields)) {
    const hit = value ? scanText(value, field) : null;
    if (hit) return hit;
  }
  return null;
}

/** The message shown when a post is blocked. Names the kind of secret and where — never the value. */
export function blockedMessage(hit: SecretHit): string {
  const where = hit.field === "text" ? `line ${hit.line}` : `${hit.field.replace(/_/g, " ")}, line ${hit.line}`;
  return `Blocked: this looks like it contains ${hit.label} (${where}). Nothing was posted. Remove the secret and post again; credentials never belong on a shared board.`;
}
