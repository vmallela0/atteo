// Pins and cross-signed device lists (E2E design §2.2), shared by the CLI's key loop (commands.ts boardKeys).
import { deviceSigned, verifyDevice } from "./sealed";

export type SignedDevice = { kid: string; user: string; public_key: string; sign_pub?: string | null; signed_by?: string | null; sig?: string | null };

/** A pin: the device id, its X25519 key and (once seen) its Ed25519 signing key. Older pins have the first two only. */
export const pinId = (kid: string, publicKey: string, signPub?: string | null) => `${kid}|${publicKey}${signPub ? `|${signPub}` : ""}`;
export const pinned = (list: string[] | undefined, kid: string, publicKey: string) => list?.find((e) => e === pinId(kid, publicKey) || e.startsWith(`${pinId(kid, publicKey)}|`));

/**
 * A device signed by one this machine pinned, checked against the signing key pinned with it (never the one the server
 * shows now), is pinned too, so it gets board keys from here. A pinned device seen with a signing key for the first time
 * gets that key pinned (first sight, like the device itself). Changes `pin` in place.
 */
export function crossSigned(pin: Record<string, string[]>, devices: SignedDevice[]) {
  for (const d of devices) {
    const e = pinned(pin[d.user], d.kid, d.public_key);
    if (e && e.split("|").length === 2 && d.sign_pub) pin[d.user] = pin[d.user].map((x) => (x === e ? pinId(d.kid, d.public_key, d.sign_pub) : x));
  }
  for (let more = true; more; ) {
    more = false;
    for (const d of devices) {
      if (pinned(pin[d.user], d.kid, d.public_key) || !d.signed_by || !d.sig) continue;
      const signer = pin[d.user]?.map((x) => x.split("|")).find((p) => p[0] === d.signed_by && p[2]);
      if (signer && verifyDevice(signer[2], deviceSigned(d.user, d.kid, d.public_key, d.sign_pub ?? null), d.sig)) {
        (pin[d.user] ??= []).push(pinId(d.kid, d.public_key, d.sign_pub));
        more = true;
      }
    }
  }
}
