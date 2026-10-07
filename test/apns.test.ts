import { afterEach, describe, expect, it, vi } from "vitest";
import { sendApprovalAlert } from "../src/apns";
import type { Env } from "../src/types";

afterEach(() => vi.unstubAllGlobals());

describe("approval APNs alerts", () => {
  it("signs an APNs JWT and sends the approval path to a registered phone", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...raw))}\n-----END PRIVATE KEY-----`;
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 200 }); });
    const env = { APNS_KEY: pem, APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM123", APNS_TOPIC: "com.atteo.app", DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ token: "ab".repeat(32) }] }) }) }) } } as unknown as Env;
    await sendApprovalAlert(env, "owner", "Confirm terminal approval", "Review the action", "/approvals#ap_test");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.push.apple.com/3/device/${"ab".repeat(32)}`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["apns-topic"]).toBe("com.atteo.app");
    expect(headers["apns-push-type"]).toBe("alert");
    const jwt = headers.authorization.split(" ")[1];
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")))).toMatchObject({ iss: "TEAM123" });
    const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, sig, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ aps: { alert: { title: "Confirm terminal approval", body: "Review the action" } }, url: "/approvals#ap_test" });
  });
});
