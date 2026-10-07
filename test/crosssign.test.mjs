import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { crossSigned, dropGone, pinId, pinned } from "../cli/src/crosssign";
import { deviceSigned, verifyDevice } from "../cli/src/sealed";
import { deviceSigned as serverSigned } from "../src/boardkeys";

const b64 = (u) => Buffer.from(u, "base64url").toString("base64");
function device(user, kid) {
  const ed = generateKeyPairSync("ed25519");
  const x = generateKeyPairSync("x25519");
  return {
    kid,
    user,
    public_key: b64(x.publicKey.export({ format: "jwk" }).x),
    sign_pub: b64(ed.publicKey.export({ format: "jwk" }).x),
    signs: (d) => sign(null, Buffer.from(deviceSigned(d.user, d.kid, d.public_key, d.sign_pub)), ed.privateKey).toString("base64"),
  };
}
const plain = ({ signs, ...d }) => d;

describe("cross-signed device lists (E2E design §2.2, Phase 1c)", () => {
  it("the CLI and the server sign the same bytes", () => {
    expect(deviceSigned("ana", "k1", "PUB", "SPUB")).toBe(serverSigned("ana", "k1", "PUB", "SPUB"));
    expect(deviceSigned("ana", "k1", "PUB", null)).toBe("atteo device v1\nana\nk1\nPUB\n");
  });

  it("a device signed by one you pinned is pinned, with its signer; chains follow; a forged or re-targeted signature isn't", () => {
    const a1 = device("ana", "a1"), a2 = device("ana", "a2"), a3 = device("ana", "a3"), evil = device("ana", "ev");
    const pin = { ana: [pinId(a1.kid, a1.public_key, a1.sign_pub)] };
    const s2 = { ...plain(a2), signed_by: "a1", sig: a1.signs(a2) };
    const s3 = { ...plain(a3), signed_by: "a2", sig: a2.signs(a3) }; // signed by a2, which is trusted only through a1
    const forged = { ...plain(evil), signed_by: "a1", sig: evil.signs(evil) }; // the server made it: it can't sign as a1
    const moved = { ...plain(evil), signed_by: "a1", sig: a1.signs(a2) }; // a real signature, for another device
    crossSigned(pin, [s3, forged, moved, s2]);
    expect(pin.ana).toContain(pinId(a2.kid, a2.public_key, a2.sign_pub, "a1"));
    expect(pin.ana).toContain(pinId(a3.kid, a3.public_key, a3.sign_pub, "a2"));
    expect(pin.ana.some((e) => e.startsWith("ev|"))).toBe(false);
    expect(pinned(pin.ana, "a2", a2.public_key)).toBeTruthy();
  });

  it("checks against the signing key pinned with the signer, not the one the server shows now", () => {
    const a1 = device("ana", "a1"), a2 = device("ana", "a2"), swap = device("ana", "a1");
    const pin = { ana: [pinId(a1.kid, a1.public_key, a1.sign_pub)] };
    const fake = { ...plain(a2), signed_by: "a1", sig: swap.signs(a2) };
    crossSigned(pin, [{ ...plain(a1), sign_pub: swap.sign_pub }, fake]);
    expect(pin.ana).toEqual([pinId(a1.kid, a1.public_key, a1.sign_pub)]);
  });

  it("review #5523: an older pin (id|key) never takes a signing key later, so a key the server set on it vouches for nothing", () => {
    const a1 = device("ana", "a1"), evil = device("ana", "ev");
    const pin = { ana: [pinId(a1.kid, a1.public_key)] };
    // The server shows a1 with a signing key of its own choosing, and a device "signed" with it.
    const a1Shown = { ...plain(a1), sign_pub: evil.sign_pub };
    const bad = { ...plain(device("ana", "a9")), signed_by: "a1" };
    bad.sig = evil.signs(bad);
    crossSigned(pin, [a1Shown, bad]);
    expect(pin.ana).toEqual([pinId(a1.kid, a1.public_key)]);
    expect(verifyDevice(a1.sign_pub, "x", "not a signature")).toBe(false);
  });

  it("review #5524: a removed device loses its pin, and so does every device trusted through it", () => {
    const a1 = device("ana", "a1"), a2 = device("ana", "a2"), a3 = device("ana", "a3"), a4 = device("ana", "a4"), b1 = device("bo", "b1");
    const pin = {
      ana: [pinId(a1.kid, a1.public_key, a1.sign_pub), pinId(a2.kid, a2.public_key, a2.sign_pub, "a1"), pinId(a3.kid, a3.public_key, a3.sign_pub, "a2"), pinId(a4.kid, a4.public_key, a4.sign_pub)],
      bo: [pinId(b1.kid, b1.public_key)],
      cy: ["c1|KEY"], // not on this board: left alone
    };
    // a1 was removed; the server still lists a2 and a3 (it didn't revoke them, or it lies).
    const dropped = dropGone(pin, [plain(a2), plain(a3), plain(a4), plain(b1)]);
    expect(pin.ana).toEqual([pinId(a4.kid, a4.public_key, a4.sign_pub)]);
    expect(dropped.map((e) => e.split("|")[0]).sort()).toEqual(["a1", "a2", "a3"]);
    expect(pin.bo).toHaveLength(1);
    expect(pin.cy).toEqual(["c1|KEY"]);
  });
});
