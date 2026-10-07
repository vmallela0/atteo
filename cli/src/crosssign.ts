// Pins and cross-signed device lists (E2E design §2.2), shared by the CLI's key loop (commands.ts boardKeys).
import { deviceSigned, verifyDevice } from "./sealed";

export type SignedDevice = { kid: string; user: string; public_key: string; sign_pub?: string | null; signed_by?: string | null; sig?: string | null };

/**
 * A pin: the device id, its X25519 key, its Ed25519 signing key when it had one at first sight, and, for a device
 * trusted through a signature, the id of the device that signed it. Older pins have the first two only.
 */
export const pinId = (kid: string, publicKey: string, signPub?: string | null, via?: string) => `${kid}|${publicKey}${signPub ? `|${signPub}` : via ? "|" : ""}${via ? `|${via}` : ""}`;
export const pinned = (list: string[] | undefined, kid: string, publicKey: string) => list?.find((e) => e === pinId(kid, publicKey) || e.startsWith(`${pinId(kid, publicKey)}|`));

/**
 * A device signed by one this machine pinned, checked against the signing key pinned with it (never the one the server
 * shows now), is pinned too, so it gets board keys from here. A signing key counts only if it was there when its device
 * was first pinned: an older pin (id|key) never takes one later, so a signing key the server set afterwards on a device
 * that had none (review #5523) can't vouch for anything. Changes `pin` in place.
 */
export function crossSigned(pin: Record<string, string[]>, devices: SignedDevice[]) {
  for (let more = true; more; ) {
    more = false;
    for (const d of devices) {
      if (pinned(pin[d.user], d.kid, d.public_key) || !d.signed_by || !d.sig) continue;
      const signer = pin[d.user]?.map((x) => x.split("|")).find((p) => p[0] === d.signed_by && p[2]);
      if (signer && verifyDevice(signer[2], deviceSigned(d.user, d.kid, d.public_key, d.sign_pub ?? null), d.sig)) {
        (pin[d.user] ??= []).push(pinId(d.kid, d.public_key, d.sign_pub, d.signed_by));
        more = true;
      }
    }
  }
}

/**
 * Devices that are no longer listed for a person this board shows (removed, review #5524) lose their pins, and so does
 * every device trusted through them, so nothing here wraps a key to them again. Returns the dropped pins.
 */
export function dropGone(pin: Record<string, string[]>, devices: SignedDevice[]): string[] {
  const live = new Map<string, Set<string>>();
  for (const d of devices) (live.get(d.user) ?? live.set(d.user, new Set()).get(d.user)!).add(`${d.kid}|${d.public_key}`);
  const dropped: string[] = [];
  for (const [u, ids] of live) {
    if (!pin[u]) continue;
    const gone = new Set<string>();
    for (let more = true; more; ) {
      more = false;
      for (const e of pin[u]) {
        const p = e.split("|");
        if (gone.has(p[0])) continue;
        if (!ids.has(`${p[0]}|${p[1]}`) || (p[3] && gone.has(p[3]))) (gone.add(p[0]), (more = true));
      }
    }
    const keep = pin[u].filter((e) => !gone.has(e.split("|")[0]));
    dropped.push(...pin[u].filter((e) => gone.has(e.split("|")[0])));
    pin[u] = keep;
  }
  return dropped;
}
