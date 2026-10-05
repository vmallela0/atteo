import { describe, expect, it } from "vitest";
import { isAdminEmail, isAdminViewer, OPS_ADMIN_WORKOS_ID } from "../src/auth";
import type { Env } from "../src/types";

const env = (email = "") => ({ ADMIN_EMAIL: email }) as Env;
const session = (over: Partial<{ email: string; email_verified: number; workos_id: string }> = {}) => ({
  email: "ops@example.com",
  email_verified: 1,
  workos_id: OPS_ADMIN_WORKOS_ID,
  ...over,
});

describe("isAdminViewer", () => {
  it("ADMIN_EMAIL still makes a verified session an operator anywhere", () => {
    expect(isAdminEmail(env("Boss@Example.com"), "boss@example.com")).toBe(true);
    expect(isAdminViewer(env("boss@example.com"), session({ email: "boss@example.com", workos_id: "user_1" }), "atteo.dev")).toBe(true);
  });

  it("a localhost ops-admin session is an operator without ADMIN_EMAIL", () => {
    expect(isAdminViewer(env(), session(), "localhost")).toBe(true);
    expect(isAdminViewer(env(), session(), "127.0.0.1")).toBe(true);
  });

  it("the ops-admin marker is ignored off localhost and when the session is unverified", () => {
    expect(isAdminViewer(env(), session(), "atteo.dev")).toBe(false);
    expect(isAdminViewer(env(), session(), "workers.dev")).toBe(false);
    expect(isAdminViewer(env(), session({ email_verified: 0 }), "localhost")).toBe(false);
    expect(isAdminViewer(env(), session({ workos_id: "ops-issued" }), "localhost")).toBe(false);
    expect(isAdminViewer(env(), session(), null)).toBe(false);
  });
});
