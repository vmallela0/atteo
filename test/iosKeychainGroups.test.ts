// Who can read an encrypted board's keys on the iPhone (review #5550): they live in a Keychain group of their own,
// "<app id>.e2e", that only the app and the notification extension hold. The share extension never gets it, and the
// notification extension gets nothing else (not the app's group, where the sign-in token and device key are).
import { describe, expect, it } from "vitest";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };
const groups = (path: string) => [...readFileSync(path, "utf8").matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]);
const APP = "$(AppIdentifierPrefix)$(ATTEO_BUNDLE_ID)";
const E2E = APP + ".e2e";

describe("iOS Keychain groups for board keys", () => {
  it("the app holds both, its own group first (the default, where the sign-in stays)", () => {
    expect(groups("ios/AgentSoup/Atteo.entitlements")).toEqual([APP, E2E]);
  });

  it("the notification extension holds only the board keys' group", () => {
    expect(groups("ios/NotifyExtension/AtteoNotify.entitlements")).toEqual([E2E]);
  });

  it("the share extension never gets the board keys", () => {
    expect(groups("ios/ShareExtension/AtteoShare.entitlements")).toEqual([APP]);
    const yml = readFileSync("ios/project.yml", "utf8");
    const share = yml.slice(yml.indexOf("  AtteoShare:"), yml.indexOf("  AtteoNotify:"));
    expect(share).toMatch(/excludes:\s*\n\s*- SealedOpen\.swift/);
  });

  it("the code is told the same group (Info.plist), and sets it on every Keychain call", () => {
    for (const p of ["ios/AgentSoup/Info.plist", "ios/NotifyExtension/Info.plist"]) expect(readFileSync(p, "utf8")).toMatch(/<key>AtteoE2EKeychainGroup<\/key>\s*<string>\$\(AppIdentifierPrefix\)\$\(ATTEO_BUNDLE_ID\)\.e2e<\/string>/);
    const src = readFileSync("ios/Shared/SealedOpen.swift", "utf8");
    const keys = src.slice(src.indexOf("enum SealedKeys"), src.indexOf("\n}\n", src.indexOf("enum SealedKeys")));
    expect(keys).toContain("kSecAttrAccessGroup as String: group");
    expect(keys.match(/kSecClassGenericPassword/g)).toHaveLength(1); // one query builder, used by read, store and forget
    expect(keys).toContain("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
  });

  it("the device key is read and kept only through the .e2e group (moved there once from the app's group)", () => {
    const crypto = readFileSync("ios/AgentSoup/Sources/BoardCrypto.swift", "utf8");
    const pk = crypto.slice(crypto.indexOf("private var privateKey"), crypto.indexOf("private static var migrated"));
    const e2ePath = pk.slice(pk.indexOf("DeviceKeyStore.migrate()"));
    expect(e2ePath).toContain("DeviceKeyStore.read()");
    expect(e2ePath).toContain("DeviceKeyStore.store(");
    expect(e2ePath).not.toContain("Keychain.");
    const shared = readFileSync("ios/Shared/SealedOpen.swift", "utf8");
    const store = shared.slice(shared.indexOf("enum DeviceKeyStore"), shared.indexOf("/// What a notification"));
    expect(store).toContain("kSecAttrAccessGroup as String: group");
    expect(store).toMatch(/static func read\(in group: String\? = SealedKeys\.group\)/);
  });
});
