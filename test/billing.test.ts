import { describe, expect, it } from "vitest";
import { verifySignature } from "../src/billing";

async function sign(payload: string, secret: string, t: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  return `t=${t},v1=${[...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

describe("Stripe webhook signatures", () => {
  const now = 1_790_000_000_000;
  const t = Math.floor(now / 1000);
  it("accepts a valid signature and rejects tampering, wrong secrets, stale or missing headers", async () => {
    const body = '{"type":"customer.subscription.updated"}';
    const h = await sign(body, "whsec_a", t);
    expect(await verifySignature(body, h, "whsec_a", now)).toBe(true);
    expect(await verifySignature(body + " ", h, "whsec_a", now)).toBe(false);
    expect(await verifySignature(body, h, "whsec_b", now)).toBe(false);
    expect(await verifySignature(body, h, "whsec_a", now + 10 * 60_000)).toBe(false);
    expect(await verifySignature(body, null, "whsec_a", now)).toBe(false);
    expect(await verifySignature(body, `t=${t},v0=abc,${h.split(",")[1]}`, "whsec_a", now)).toBe(true);
  });
});
