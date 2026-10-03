import { describe, expect, it } from "vitest";
import { deviceLabel, fakeAllowed, isTestEmail, normalizeEmail } from "../src/appSignin";

const u = (s: string) => new URL(s);
const on = { DEV_FAKE_MAGIC: "1", WORKOS_API_KEY: "sk_x", WORKOS_CLIENT_ID: "client_x" };
const off = { WORKOS_API_KEY: "sk_x", WORKOS_CLIENT_ID: "client_x" };

describe("app sign-in: the local fake code (000000)", () => {
  it("is never allowed off this machine, whatever the env says", () => {
    for (const host of ["https://agent-board.vedu-mallela.workers.dev", "https://atteo.dev", "https://localhost.atteo.dev", "https://example.com"]) {
      expect(fakeAllowed(on, u(`${host}/api/app/signin/verify`), "a@example.com")).toBe(false);
      expect(fakeAllowed({}, u(`${host}/api/app/signin/verify`), "a@example.com")).toBe(false);
    }
  });

  it("only for test addresses, even locally", () => {
    expect(fakeAllowed(on, u("http://localhost:8836/x"), "vedu@gmail.com")).toBe(false);
    expect(fakeAllowed(on, u("http://localhost:8836/x"), "a@example.com.evil.io")).toBe(false);
    expect(fakeAllowed(on, u("http://localhost:8836/x"), "a@example.com")).toBe(true);
    expect(fakeAllowed(on, u("http://127.0.0.1:8836/x"), "a@team.test")).toBe(true);
  });

  it("locally: with DEV_FAKE_MAGIC=1, or when WorkOS isn't configured; not otherwise", () => {
    expect(fakeAllowed(off, u("http://localhost:8836/x"), "a@example.com")).toBe(false);
    expect(fakeAllowed({ ...off, DEV_FAKE_MAGIC: "true" }, u("http://localhost:8836/x"), "a@example.com")).toBe(false);
    expect(fakeAllowed({}, u("http://localhost:8836/x"), "a@example.com")).toBe(true);
    expect(fakeAllowed({ WORKOS_CLIENT_ID: "client_x" }, u("http://localhost:8836/x"), "a@example.com")).toBe(true);
  });
});

describe("app sign-in: inputs", () => {
  it("normalizes emails and refuses malformed ones", () => {
    expect(normalizeEmail("  Vedu@Example.COM ")).toBe("vedu@example.com");
    for (const bad of ["", "vedu", "vedu@", "@x.io", "a b@x.io", "a@x", "<a@x.io>", null, 42]) expect(normalizeEmail(bad)).toBeNull();
  });

  it("test addresses are reserved domains only", () => {
    expect(isTestEmail("x@example.org")).toBe(true);
    expect(isTestEmail("x@qa.test")).toBe(true);
    expect(isTestEmail("x@examples.com")).toBe(false);
    expect(isTestEmail("x@test.com")).toBe(false);
  });

  it("device names become short, printable labels", () => {
    expect(deviceLabel("iPhone")).toBe("iPhone");
    expect(deviceLabel("a\u0000b\nc")).toBe("abc");
    expect(deviceLabel("x".repeat(80))?.length).toBe(40);
    expect(deviceLabel("  ")).toBeNull();
    expect(deviceLabel(7)).toBeNull();
  });
});
