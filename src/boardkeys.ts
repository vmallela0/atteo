// Encryption v2 (end-to-end encrypted boards): one key per board per epoch, wrapped once for each member device.
// The server keeps the wrapped copies (grants) and the rules for who may hand a copy to whom; it never sees a key.
//
// Rules, enforced here (not left to clients):
// - A member's FIRST device on a board may be granted the key by any member who holds it (trust on first use).
// - Any LATER device of that member may only be granted by one of that member's own devices that already holds the
//   key (like linked devices in Signal), so the server can't quietly add a "device" and read the board.
// - Every grant shows up on the board as a visible line, so a device nobody recognises is seen.
// - Removing a member or revoking a device drops its copies and flags the board; the next client that encrypts opens
//   a new epoch, granted only to those remaining. Newcomers get every epoch (they can read the history).

import type { Env } from "./types";

export class KeyError extends Error {}

export interface Grant {
  epoch: number;
  kid: string;
  epk: string;
  iv: string;
  wrapped: string;
}

const B64 = (n: number) => new RegExp(`^[A-Za-z0-9+/]{${Math.ceil(n / 3) * 4 - (n % 3 ? 3 - (n % 3) : 0)}}={0,2}$`);
const EPK = B64(32); // an X25519 public key
const IV = B64(12);
const WRAPPED = B64(48); // a 32-byte key + 16-byte GCM tag

/** A grant's shape; `noKid` for a copy wrapped to an invite key rather than a device. */
export function checkGrant(g: Partial<Grant>, noKid = false): Grant {
  const epoch = Number(g.epoch);
  if (!Number.isInteger(epoch) || epoch < 1) throw new KeyError("Each grant needs its epoch (1, 2, …).");
  if (!noKid && (typeof g.kid !== "string" || !/^[a-z0-9-]{1,40}$/.test(g.kid))) throw new KeyError("Each grant needs the device key id (kid).");
  if (typeof g.epk !== "string" || !EPK.test(g.epk)) throw new KeyError("epk must be a base64 X25519 public key.");
  if (typeof g.iv !== "string" || !IV.test(g.iv)) throw new KeyError("iv must be 12 bytes, base64.");
  if (typeof g.wrapped !== "string" || !WRAPPED.test(g.wrapped)) throw new KeyError("wrapped must be the 32-byte key plus its 16-byte tag, base64.");
  return { epoch, kid: g.kid ?? "", epk: g.epk, iv: g.iv, wrapped: g.wrapped };
}

/** Members' live device keys on a board. */
async function memberKeys(env: Env, board: string) {
  return (
    await env.DB.prepare(
      `SELECT k.id, k.user, k.public_key, k.label, k.sign_pub, k.signed_by, k.sig FROM agent_keys k JOIN members m ON m.user = k.user WHERE m.board_id = ? AND k.revoked_at IS NULL ORDER BY k.created_at`,
    )
      .bind(board)
      .all<{ id: string; user: string; public_key: string; label: string | null; sign_pub: string | null; signed_by: string | null; sig: string | null }>()
  ).results;
}

/** A device as clients see it, with its signing key and who signed it (null on devices from before signing). */
const signed = (k: { id: string; user: string; public_key: string; label: string | null; sign_pub: string | null; signed_by: string | null; sig: string | null }) => ({
  kid: k.id,
  user: k.user,
  public_key: k.public_key,
  label: k.label,
  sign_pub: k.sign_pub,
  signed_by: k.signed_by,
  sig: k.sig,
});

// ---- cross-signed device lists (E2E design §2.2): a person's later device is signed by one of their existing devices ----

/** What a device signature covers: the person, the device id, its X25519 key and its own signing key. Never change it. */
export const deviceSigned = (user: string, kid: string, publicKey: string, signPub: string | null) => `atteo device v1\n${user}\n${kid}\n${publicKey}\n${signPub ?? ""}`;

const SIG = B64(64);
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * One of your devices (`by`) signs another of yours (`kid`), when it approves it. The server checks the signature too,
 * for hygiene; the check that matters is each client's, against the signer's key it pinned. Returns both devices and
 * your encrypted boards, where everyone then sees the change.
 */
export async function signDevice(env: Env, user: string, kid: string, body: { by?: unknown; sig?: unknown }) {
  const by = String(body.by ?? "");
  const sig = String(body.sig ?? "");
  if (!SIG.test(sig)) throw new KeyError("sig must be a base64 Ed25519 signature (64 bytes).");
  const rows = (
    await env.DB.prepare(`SELECT id, user, public_key, label, sign_pub, signed_by, sig FROM agent_keys WHERE user = ? AND revoked_at IS NULL AND id IN (?, ?)`)
      .bind(user, kid, by)
      .all<{ id: string; user: string; public_key: string; label: string | null; sign_pub: string | null; signed_by: string | null; sig: string | null }>()
  ).results;
  const target = rows.find((r) => r.id === kid);
  const signer = rows.find((r) => r.id === by);
  if (!target) throw new KeyError("No such device key of yours.");
  if (!signer || by === kid) throw new KeyError("Sign with another of your live devices.");
  if (!signer.sign_pub) throw new KeyError("That device has no signing key yet.");
  if (target.sig) throw new KeyError("That device is already signed.");
  const key = await crypto.subtle.importKey("raw", unb64(signer.sign_pub), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(sig), new TextEncoder().encode(deviceSigned(user, kid, target.public_key, target.sign_pub)));
  if (!ok) throw new KeyError("The signature doesn't match that device.");
  const r = await env.DB.prepare(`UPDATE agent_keys SET signed_by = ?, sig = ? WHERE id = ? AND user = ? AND sig IS NULL`).bind(by, sig, kid, user).run();
  if (!r.meta.changes) throw new KeyError("That device is already signed.");
  const boards = (await env.DB.prepare(`SELECT b.id FROM boards b JOIN members m ON m.board_id = b.id WHERE m.user = ? AND b.encrypted = 1 AND b.archived_at IS NULL`).bind(user).all<{ id: string }>()).results.map((x) => x.id);
  return { target, signer, boards };
}

// ---- a device's signing key, set only with proof it holds the device's X25519 key (review #5523) ----

/** Its own HKDF label: a proof must never be able to unwrap a board key (or the reverse), so it's never "board key v2". */
const PROOF_INFO = "atteo sign-key proof v1";
const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a));
const KEY32B64 = /^[A-Za-z0-9+/]{43}=$/;

/** `data` sealed to an X25519 public key: X25519(ephemeral, recipient) → HKDF-SHA256(salt = epk ‖ recipient) → AES-256-GCM. */
async function sealTo(recipient: string, data: Uint8Array, info: string) {
  const S = crypto.subtle;
  const e = (await S.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = new Uint8Array((await S.exportKey("raw", e.publicKey)) as ArrayBuffer);
  const rpk = unb64(recipient);
  const shared = await S.deriveBits({ name: "X25519", public: await S.importKey("raw", rpk, { name: "X25519" }, false, []) } as unknown as SubtleCryptoDeriveKeyAlgorithm, e.privateKey, 256);
  const salt = new Uint8Array(64);
  salt.set(epk);
  salt.set(rpk, 32);
  const hk = await S.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const raw = await S.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) }, hk, 256);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await S.encrypt({ name: "AES-GCM", iv }, await S.importKey("raw", raw, "AES-GCM", false, ["encrypt"]), data);
  return { epk: b64(epk), iv: b64(iv), wrapped: b64(new Uint8Array(ct)) };
}
const sha256b64 = async (a: Uint8Array) => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", a)));

/**
 * A device asks to have `signPub` as its signing key: the server seals a fresh nonce to the device's X25519 key and
 * remembers its hash for 10 minutes. Only a device that holds the private key can send it back (proveSignKey). Nothing
 * for a device that already has one: it's set once.
 */
export async function signKeyChallenge(env: Env, user: string, kid: string, signPub: string) {
  if (!KEY32B64.test(signPub)) throw new KeyError("sign_pub must be a base64 Ed25519 key (32 bytes).");
  const k = await env.DB.prepare(`SELECT public_key, sign_pub FROM agent_keys WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(kid, user).first<{ public_key: string; sign_pub: string | null }>();
  if (!k || k.sign_pub) return null;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const challenge = await sealTo(k.public_key, nonce, PROOF_INFO);
  await env.DB.prepare(`UPDATE agent_keys SET sign_challenge = ? WHERE id = ? AND user = ? AND sign_pub IS NULL`)
    .bind(JSON.stringify({ h: await sha256b64(nonce), sign_pub: signPub, until: Date.now() + 600_000 }), kid, user)
    .run();
  return challenge;
}

/** The device sends the nonce back: its signing key is set (once). */
export async function proveSignKey(env: Env, user: string, kid: string, body: { nonce?: unknown }) {
  const k = await env.DB.prepare(`SELECT sign_pub, sign_challenge FROM agent_keys WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(kid, user).first<{ sign_pub: string | null; sign_challenge: string | null }>();
  if (!k) throw new KeyError("No such device key of yours.");
  if (k.sign_pub) throw new KeyError("That device already has its signing key.");
  const c = k.sign_challenge ? (JSON.parse(k.sign_challenge) as { h: string; sign_pub: string; until: number }) : null;
  const nonce = typeof body.nonce === "string" && KEY32B64.test(body.nonce) ? unb64(body.nonce) : null;
  if (!c || c.until < Date.now() || !nonce || (await sha256b64(nonce)) !== c.h) throw new KeyError("That isn't the answer to this device's challenge; register the key again.");
  const r = await env.DB.prepare(`UPDATE agent_keys SET sign_pub = ?, sign_challenge = NULL WHERE id = ? AND user = ? AND sign_pub IS NULL`).bind(c.sign_pub, kid, user).run();
  if (!r.meta.changes) throw new KeyError("That device already has its signing key.");
}

/** The visible line on each of the person's encrypted boards when their device list changes. */
export function deviceNotice(user: string, t: { id: string; label: string | null }, s: { id: string; label: string | null }): string {
  const name = (k: { id: string; label: string | null }) => `${k.label ? `“${k.label}”` : "device"} (key ${k.id.slice(0, 6)})`;
  return `🔑 ${user} added a device, ${name(t)}, signed by their ${name(s)}. Members' devices can hand it this board's key.`;
}

/**
 * Where a board's keys stand, for one viewer: the current epoch, whether it must rotate, the viewer's own wrapped
 * copies, and the copies this viewer may hand out now (each with the epochs to wrap).
 */
export async function state(env: Env, board: string, viewer: string) {
  const [epochs, flag, grants, keys] = await Promise.all([
    env.DB.prepare(`SELECT epoch FROM board_epochs WHERE board_id = ? ORDER BY epoch`).bind(board).all<{ epoch: number }>(),
    env.DB.prepare(`SELECT rotate_needed FROM boards WHERE id = ?`).bind(board).first<{ rotate_needed: number }>(),
    env.DB.prepare(`SELECT epoch, kid, user, epk, iv, wrapped FROM key_grants WHERE board_id = ?`).bind(board).all<Grant & { user: string }>(),
    memberKeys(env, board),
  ]);
  const all = epochs.results.map((e) => e.epoch);
  const mine = grants.results.filter((g) => g.user === viewer);
  const iHold = new Set(mine.map((g) => g.epoch));
  const has = new Set(grants.results.map((g) => `${g.epoch}:${g.kid}`));
  const usersWithKey = new Set(grants.results.map((g) => g.user));
  const missing = keys
    .map((k) => {
      const first = !usersWithKey.has(k.user);
      // Later devices are for their owner's own devices to approve, or anyone's once one of those signed it (clients
      // check the signature against the signer they pinned); first devices, for anyone holding the key.
      if (!first && k.user !== viewer && !k.signed_by) return null;
      const need = all.filter((e) => iHold.has(e) && !has.has(`${e}:${k.id}`));
      return need.length ? { ...signed(k), first_device: first, epochs: need } : null;
    })
    .filter((x) => x !== null);
  return {
    current: all.length ? all[all.length - 1] : 0,
    rotate_needed: !!flag?.rotate_needed,
    mine: mine.map(({ epoch, kid, epk, iv, wrapped }) => ({ epoch, kid, epk, iv, wrapped })),
    missing,
    // Every member device the next epoch must be wrapped to (opening one wraps to all of these).
    keys: keys.map(signed),
  };
}

/**
 * Opens the next epoch: epoch 1 for a board that has none, or N+1 after a removal. The opener wraps the new key to
 * every current member device (at least one of its own). Two clients racing: one wins, the other is told to refetch.
 */
export async function openEpoch(env: Env, board: string, viewer: string, body: { epoch?: unknown; grants?: unknown }) {
  const epoch = Number(body.epoch);
  const cur = (await env.DB.prepare(`SELECT MAX(epoch) AS e FROM board_epochs WHERE board_id = ?`).bind(board).first<{ e: number | null }>())?.e ?? 0;
  if (epoch !== cur + 1) throw new KeyError(`The next epoch is ${cur + 1}; refetch the board's keys.`);
  const list = (Array.isArray(body.grants) ? body.grants : []).map((g) => checkGrant({ ...(g as Partial<Grant>), epoch }));
  if (!list.length || list.length > 500) throw new KeyError("Wrap the new key to every member device (1–500 grants).");
  const keys = new Map((await memberKeys(env, board)).map((k) => [k.id, k]));
  for (const g of list) if (!keys.has(g.kid)) throw new KeyError(`Device ${g.kid} isn't a live key of a member of this board.`);
  if (!list.some((g) => keys.get(g.kid)!.user === viewer)) throw new KeyError("Include one of your own devices, or you couldn't read what you post.");
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO board_epochs (board_id, epoch, created_by, created_at) VALUES (?, ?, ?, ?)`).bind(board, epoch, viewer, now),
      ...list.map((g) =>
        env.DB.prepare(`INSERT INTO key_grants (board_id, epoch, kid, user, epk, iv, wrapped, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          board, epoch, g.kid, keys.get(g.kid)!.user, g.epk, g.iv, g.wrapped, viewer, now,
        ),
      ),
      env.DB.prepare(`UPDATE boards SET rotate_needed = 0 WHERE id = ?`).bind(board),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE") || String(e).includes("PRIMARY KEY")) throw new KeyError(`Epoch ${epoch} was just opened by someone else; refetch the board's keys.`);
    throw e;
  }
  return { epoch, users: [...new Set(list.map((g) => keys.get(g.kid)!.user))] };
}

/** Hands copies of existing epoch keys to devices that lack them, under the rules above. Returns what was added. */
export async function addGrants(env: Env, board: string, viewer: string, body: { grants?: unknown }) {
  const list = (Array.isArray(body.grants) ? body.grants : []).map((g) => checkGrant(g as Partial<Grant>));
  if (!list.length || list.length > 500) throw new KeyError("Send 1–500 grants.");
  const [keys, existing] = await Promise.all([
    memberKeys(env, board),
    env.DB.prepare(`SELECT epoch, kid, user FROM key_grants WHERE board_id = ?`).bind(board).all<{ epoch: number; kid: string; user: string }>(),
  ]);
  const byKid = new Map(keys.map((k) => [k.id, k]));
  const iHold = new Set(existing.results.filter((g) => g.user === viewer).map((g) => g.epoch));
  const usersWithKey = new Set(existing.results.map((g) => g.user));
  const has = new Set(existing.results.map((g) => `${g.epoch}:${g.kid}`));
  const added: { kid: string; user: string; label: string | null; first_device: boolean }[] = [];
  const stmts: D1PreparedStatement[] = [];
  const now = Date.now();
  for (const g of list) {
    const k = byKid.get(g.kid);
    if (!k) throw new KeyError(`Device ${g.kid} isn't a live key of a member of this board.`);
    if (!iHold.has(g.epoch)) throw new KeyError(`You don't hold epoch ${g.epoch}'s key, so you can't hand it on.`);
    const first = !usersWithKey.has(k.user);
    if (!first && k.user !== viewer && !k.signed_by)
      throw new KeyError(`${k.user} already reads this board; only one of ${k.user}'s own devices can add another of theirs (or anyone, once one of them signed it).`);
    if (has.has(`${g.epoch}:${g.kid}`)) continue;
    has.add(`${g.epoch}:${g.kid}`);
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO key_grants (board_id, epoch, kid, user, epk, iv, wrapped, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        board, g.epoch, g.kid, k.user, g.epk, g.iv, g.wrapped, viewer, now,
      ),
    );
    if (!added.some((a) => a.kid === g.kid)) added.push({ kid: g.kid, user: k.user, label: k.label, first_device: first });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { added };
}

/**
 * A member's first device takes the board key from an invite link it was opened with (E2E design §3.3): the device
 * unwrapped the link's copies with the private half from the link's "#", and hands them to itself. Allowed only for the
 * person's own live devices, only while none of their devices reads the board yet, and only for the epochs the link
 * carries. The server can't check the wrap, but a wrong one only locks that person out of their own copy.
 */
export async function addInviteGrants(env: Env, board: string, viewer: string, linkEpochs: Set<number>, body: { grants?: unknown }) {
  const list = (Array.isArray(body.grants) ? body.grants : []).map((g) => checkGrant(g as Partial<Grant>));
  if (!list.length || list.length > 500) throw new KeyError("Send 1–500 grants.");
  const [keys, mineAlready] = await Promise.all([
    memberKeys(env, board),
    env.DB.prepare(`SELECT 1 AS x FROM key_grants WHERE board_id = ? AND user = ? LIMIT 1`).bind(board, viewer).first(),
  ]);
  if (mineAlready) throw new KeyError("One of your devices already reads this board; it hands the key to your others.");
  const byKid = new Map(keys.map((k) => [k.id, k]));
  const added: { kid: string; user: string; label: string | null; first_device: boolean }[] = [];
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const g of list) {
    const k = byKid.get(g.kid);
    if (!k || k.user !== viewer) throw new KeyError(`Device ${g.kid} isn't one of your live device keys.`);
    if (!linkEpochs.has(g.epoch)) throw new KeyError(`The link doesn't carry epoch ${g.epoch}'s key.`);
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO key_grants (board_id, epoch, kid, user, epk, iv, wrapped, granted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        board, g.epoch, g.kid, viewer, g.epk, g.iv, g.wrapped, viewer, now,
      ),
    );
    if (!added.some((a) => a.kid === g.kid)) added.push({ kid: g.kid, user: viewer, label: k.label, first_device: true });
  }
  await env.DB.batch(stmts);
  return { added };
}

/** The visible line for a device that took the board key from an invite link. */
export function inviteNotice(a: { kid: string; user: string; label: string | null }): string {
  return `🔑 ${a.user} joined with an invite link that carries this board's key; their ${a.label ? `“${a.label}”` : "device"} (key ${a.kid.slice(0, 6)}) can read it now.`;
}

/** The visible line for a grant, so everyone sees which devices can read the board. */
export function grantNotice(granter: string, a: { kid: string; user: string; label: string | null; first_device: boolean }): string {
  const device = `${a.label ? `“${a.label}”` : "a device"} (key ${a.kid.slice(0, 6)})`;
  return a.user === granter
    ? `🔑 ${granter} added another of their devices, ${device}, to this encrypted board.`
    : `🔑 ${granter} gave ${a.user}'s ${device} the key to this encrypted board.`;
}

/**
 * Revokes one of your device keys, and every device it signed, and every device those signed (a lost laptop vouched for
 * them, so they go with it). Their copies of every board key go, and those boards start a new key. Returns the revoked
 * devices and your encrypted boards, where everyone then sees which devices went.
 */
export async function revokeDevice(env: Env, user: string, kid: string) {
  const live = (await env.DB.prepare(`SELECT id, label, signed_by FROM agent_keys WHERE user = ? AND revoked_at IS NULL`).bind(user).all<{ id: string; label: string | null; signed_by: string | null }>()).results;
  if (!live.some((k) => k.id === kid)) throw new KeyError("No such device key.");
  const gone = new Set([kid]);
  for (let more = true; more; ) {
    more = false;
    for (const k of live) if (!gone.has(k.id) && k.signed_by && gone.has(k.signed_by)) (gone.add(k.id), (more = true));
  }
  const now = Date.now();
  await env.DB.batch(
    [...gone].flatMap((id) => [
      env.DB.prepare(`UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND user = ?`).bind(now, id, user),
      env.DB.prepare(`UPDATE boards SET rotate_needed = 1 WHERE id IN (SELECT board_id FROM key_grants WHERE kid = ?)`).bind(id),
      env.DB.prepare(`DELETE FROM key_grants WHERE kid = ?`).bind(id),
    ]),
  );
  const boards = (await env.DB.prepare(`SELECT b.id FROM boards b JOIN members m ON m.board_id = b.id WHERE m.user = ? AND b.encrypted = 1 AND b.archived_at IS NULL`).bind(user).all<{ id: string }>()).results.map((x) => x.id);
  return { revoked: live.filter((k) => gone.has(k.id)), boards };
}

/** The visible line when a person removes devices: the device, and every device it had signed. */
export function revokeNotice(user: string, revoked: { id: string; label: string | null }[]): string {
  const name = (k: { id: string; label: string | null }) => `${k.label ? `“${k.label}”` : "device"} (key ${k.id.slice(0, 6)})`;
  const [first, ...rest] = revoked;
  return `🔑 ${user} removed ${name(first)}${rest.length ? `, and the devices it had signed: ${rest.map(name).join(", ")}` : ""}. They can't read new messages; this board gets a new key.`;
}
