import { describe, expect, it } from "vitest";
import { isAdminEmail, isAdminViewer, OPS_ADMIN_WORKOS_ID } from "../src/auth";
import type { Env } from "../src/types";

const env = (over: Partial<Env> = {}) => ({ ADMIN_EMAIL: "", ...over }) as Env;
const session = (over: Partial<{ email: string; email_verified: number; workos_id: string }> = {}) => ({
  email: "ops@example.com",
  email_verified: 1,
  workos_id: OPS_ADMIN_WORKOS_ID,
  ...over,
});

describe("isAdminViewer", () => {
  it("ADMIN_EMAIL still makes a verified session an operator anywhere", () => {
    expect(isAdminEmail(env({ ADMIN_EMAIL: "Boss@Example.com" }), "boss@example.com")).toBe(true);
    expect(isAdminViewer(env({ ADMIN_EMAIL: "boss@example.com" }), session({ email: "boss@example.com", workos_id: "user_1" }), "atteo.dev")).toBe(true);
  });

  it("a localhost ops-admin session is an operator only with DEV_FAKE_ADMIN=1", () => {
    const on = env({ DEV_FAKE_ADMIN: "1" });
    expect(isAdminViewer(on, session(), "localhost")).toBe(true);
    expect(isAdminViewer(on, session(), "127.0.0.1")).toBe(true);
    expect(isAdminViewer(env(), session(), "localhost")).toBe(false);
    expect(isAdminViewer(env({ DEV_FAKE_ADMIN: "true" }), session(), "localhost")).toBe(false);
  });

  it("the ops-admin marker is ignored off localhost, without the flag, and when unverified", () => {
    const on = env({ DEV_FAKE_ADMIN: "1" });
    expect(isAdminViewer(on, session(), "atteo.dev")).toBe(false);
    expect(isAdminViewer(on, session(), "workers.dev")).toBe(false);
    expect(isAdminViewer(on, session({ email_verified: 0 }), "localhost")).toBe(false);
    expect(isAdminViewer(on, session({ workos_id: "ops-issued" }), "localhost")).toBe(false);
    expect(isAdminViewer(on, session(), null)).toBe(false);
  });
});
