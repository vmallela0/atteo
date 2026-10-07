// Minimal APNs alert delivery for person-only approval notifications.
import type { Env } from "./types";

const url64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json64 = (v: object) => url64(new TextEncoder().encode(JSON.stringify(v)));
function pkcs8(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** Send an alert to the person's registered iOS devices when APNs signing is configured. */
export async function sendApprovalAlert(env: Env, user: string, title: string, body: string, path: string): Promise<void> {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return;
  const devices = (await env.DB.prepare(`SELECT token FROM push_devices WHERE user = ? AND platform = 'ios'`).bind(user).all<{ token: string }>()).results;
  if (!devices.length) return;
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(env.APNS_KEY).buffer as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = json64({ alg: "ES256", kid: env.APNS_KEY_ID });
  const claims = json64({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) });
  const signed = `${head}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signed)));
  const jwt = `${signed}.${url64(sig)}`;
  const payload = JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, url: path });
  await Promise.all(devices.map(async d => {
    const res = await fetch(`https://api.push.apple.com/3/device/${d.token}`, { method: "POST", headers: { authorization: `bearer ${jwt}`, "apns-topic": env.APNS_TOPIC!, "apns-push-type": "alert", "content-type": "application/json" }, body: payload });
    if (res.status === 410) await env.DB.prepare(`DELETE FROM push_devices WHERE token = ? AND user = ?`).bind(d.token, user).run();
    else if (!res.ok) console.error("APNs approval alert failed", res.status);
  }));
}
