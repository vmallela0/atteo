import { describe, expect, it } from "vitest";
import { blockedMessage, scanFields, scanText } from "../src/secrets";

// Fixtures are assembled at runtime so no key-shaped literal sits in the source (keeps secret scanners quiet).
const j = (...p: string[]) => p.join("");
const rep = (c: string, n: number) => c.repeat(n);
const mix = (n: number) => Array.from({ length: n }, (_, i) => "aB3dE5gH7jK9mN1pQ2"[i % 18]).join("");

const positives: [string, string][] = [
  ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----")],
  ["aws-access-key", j("aws_access_key_id = ", "AKIA", rep("Q", 16))],
  ["github-token", j("token: ", "ghp_", mix(36))],
  ["github-token", j("github_pat_", mix(60))],
  ["slack-token", j("xox", "b-", "1234567890-", mix(24))],
  ["stripe-live-key", j("sk_", "live_", mix(24))],
  ["anthropic-key", j("ANTHROPIC_API_KEY=", "sk-ant-", "api03-", mix(40))],
  ["openai-key", j("sk-", "proj-", mix(48))],
  ["google-api-key", j("AIza", mix(35))],
  ["workos-key", j("sk_", "test_", mix(60))],
  ["cloudflare-token", j("cfat_", mix(40))],
  ["resend-key", j("re_", mix(8), "_", mix(24))],
  ["agent-board-token", j("Authorization: Bearer ", "ab_", mix(43))],
  ["jwt", j("eyJ", mix(20), ".eyJ", mix(30), ".", mix(43))],
  ["url-credentials", j("DATABASE_URL=postgres://app:", "hunter2hunter2", "@db.internal:5432/prod")],
  ["secret-assignment", j("DB_PASSWORD=", "Tr0ub4dor&3-horse")],
  ["secret-assignment", j('{"client_secret": "', mix(20), '"}')],
];

const negatives: string[] = [
  "Request id 3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90 failed at 09:14",
  "Fixed in commit 1f3c9a7e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f13 (see PR #118)",
  "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "Our WorkOS keys start with sk_test_ in staging and sk_live_ in production.",
  "password: <your password here>",
  "api_key = process.env.OPENAI_API_KEY",
  "Set CLIENT_SECRET=${CLIENT_SECRET} in your shell",
  "secret = ********",
  "The password field is required.",
  "password = required",
  "TypeError: Cannot read properties of undefined (reading 'amount') at charge (src/charge.ts:88:31)",
  "Connect with postgres://localhost:5432/app (no password locally)",
  "Tokens look like ab_… and are shown once.",
  "AKIA is the prefix AWS uses for access key ids.",
  "Worker secrets: `WORKOS_API_KEY`, `ADMIN_KEY`.",
  "const secret = randomSecret(\"s_\", 32);",
  "ADMIN_KEY?: string; // secret: automation/test access",
  "Rotate the API_KEY=OPENAI_API_KEY_PROD reference in CI",
];

describe("secret filter", () => {
  for (const [rule, text] of positives) {
    it(`blocks ${rule}`, () => {
      const hit = scanText(text);
      expect(hit?.rule).toBe(rule);
    });
  }

  for (const text of negatives) {
    it(`allows: ${text.slice(0, 50)}`, () => {
      expect(scanText(text)).toBeNull();
    });
  }

  it("reports the field and line, and the message never contains the secret", () => {
    const key = j("ghp_", mix(36));
    const hit = scanFields({ text: "all good", artifact_content: `line one\nline two\nGH_TOKEN=${key}\n` })!;
    expect(hit.field).toBe("artifact_content");
    expect(hit.line).toBe(3);
    const msg = blockedMessage(hit);
    expect(msg).not.toContain(key);
    expect(msg).toContain("GitHub token");
    expect(msg).toContain("artifact content, line 3");
  });
});
