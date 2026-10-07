// Pins and cross-signed device lists (E2E design §2.2), shared by the CLI's key loop (commands.ts boardKeys).
import { createHash } from "node:crypto";
import { deviceSigned, verifyDevice } from "./sealed";

export type SignedDevice = { kid: string; user: string; public_key: string; sign_pub?: string | null; signed_by?: string | null; sig?: string | null };

/**
 * A pin: the device id, its X25519 key, its Ed25519 signing key when it had one at first sight, and, for a device
 * trusted through a signature, the id of the device that signed it. Older pins have the first two only.
 */
export const pinId = (kid: string, publicKey: string, signPub?: string | null, via?: string) => `${kid}|${publicKey}${signPub ? `|${signPub}` : via ? "|" : ""}${via ? `|${via}` : ""}`;
export const pinned = (list: string[] | undefined, kid: string, publicKey: string) => list?.find((e) => e === pinId(kid, publicKey) || e.startsWith(`${pinId(kid, publicKey)}|`));

/**
 * Trust on first use, for a person this machine has never seen: their first device listed (`devices`), or the one the
 * server says is their first on the board (`first`, still waiting for its key). A person seen once keeps their entry for
 * good, even when dropGone empties it: the empty list is the tombstone, so a server that hides all of someone's devices
 * and then shows a new one of its own never gets it trusted this way (review #5558). Such a device needs a signature
 * from one still pinned (crossSigned), or the person's own word (`atteo keys trust`). Changes `pin` in place.
 */
export function firstSight(pin: Record<string, string[]>, me: string, devices: SignedDevice[], first: SignedDevice[]) {
  for (const d of [...devices, ...first]) if (d.user !== me && !Object.hasOwn(pin, d.user)) pin[d.user] = [pinId(d.kid, d.public_key, d.sign_pub)];
}

/**
 * A device's fingerprint, for two people to read to each other (review #5566): SHA-256 over its X25519 key and its
 * signing key, the first 16 bytes as 8 groups of 4 hex digits. The web computes the same (src/e2eweb.ts fpOf).
 */
export const fingerprint = (publicKey: string, signPub?: string | null) =>
  createHash("sha256")
    .update(`atteo fingerprint v1\n${publicKey}\n${signPub ?? ""}`)
    .digest("hex")
    .slice(0, 32)
    .match(/.{4}/g)!
    .join(" ");
/** What someone typed or pasted as a fingerprint, compared without spaces or case. */
export const sameFingerprint = (typed: string, fp: string) => typed.replace(/[\s:-]/g, "").toLowerCase() === fp.replace(/ /g, "");

/**
 * Pins handed over by the device that approved this one (review #5567), merged into this machine's: only people this
 * machine never saw take the giver's list (their entry, empty or not, is the giver's tombstone too). A person seen here
 * is never touched: nothing is appended to a list this machine keeps (review #5592, which would get past #5558's
 * tombstone). `me` is never taken: this machine's own devices are its own call. Changes `pin` in place.
 */
export function mergePins(pin: Record<string, string[]>, got: Record<string, string[]>, me: string) {
  for (const [u, list] of Object.entries(got)) {
    if (u === me || Object.hasOwn(pin, u) || !Array.isArray(list) || !/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(u)) continue;
    pin[u] = [...new Set(list.filter((e) => typeof e === "string" && /^[a-z0-9-]{1,40}\|[A-Za-z0-9+/]{43}=/.test(e)))];
  }
}

/** The signing key pinned here for one of this person's OWN devices (never the server's word for it), or null. */
export const ownSigner = (pin: Record<string, string[]>, me: string, kid: string) => pin[me]?.map((x) => x.split("|")).find((p) => p[0] === kid && p[2])?.[2] ?? null;

/** Whether this machine knows nobody yet: no one pinned but this very device. */
export const knowsNobody = (pin: Record<string, string[]>, me: string, kid: string) => Object.keys(pin).every((u) => u === me) && (pin[me] ?? []).every((e) => e.split("|")[0] === kid);

/** A person seen before with no pinned device left: none of the devices this machine trusted for them is listed now. */
export const noneLeft = (pin: Record<string, string[]>, user: string) => Object.hasOwn(pin, user) && !pin[user].length;

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
 * every device trusted through them, so nothing here wraps a key to them again. The person's entry stays, empty if
 * nothing is left (firstSight's tombstone). Returns the dropped pins.
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
