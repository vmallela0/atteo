import { describe, expect, it } from "vitest";
import { APPLE_OAUTH_PROVIDER, authorizeUrl, loginProvider, oauthSignInLocation, requestedLoginProvider } from "../src/auth";
import { legalPage } from "../src/html";

// No node types in the test tsconfig (see docs.test.ts).
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (p: string, enc: string) => string };

const env = { WORKOS_CLIENT_ID: "client_x" } as never;

describe("Sign in with Apple (WorkOS AppleOAuth)", () => {
  it("keeps the hosted AuthKit page unless Apple was asked for", () => {
    const to = new URL(authorizeUrl(env, "https://atteo.dev/auth/callback", "s"));
    expect(to.origin + to.pathname).toBe("https://api.workos.com/user_management/authorize");
    expect(to.searchParams.get("provider")).toBe("authkit");
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("client_id")).toBe("client_x");
    expect(to.searchParams.get("redirect_uri")).toBe("https://atteo.dev/auth/callback");
    expect(to.searchParams.get("organization_id")).toBeNull();
  });

  it("sends Continue with Apple straight to AppleOAuth, and company SSO still wins", () => {
    const apple = new URL(authorizeUrl(env, "https://atteo.dev/auth/callback", "st", { provider: APPLE_OAUTH_PROVIDER, loginHint: "a@icloud.com" }));
    expect(apple.searchParams.get("provider")).toBe("AppleOAuth");
    expect(apple.searchParams.get("login_hint")).toBe("a@icloud.com");
    expect(apple.searchParams.get("state")).toBe("st");
    expect(apple.searchParams.get("organization_id")).toBeNull();

    const sso = new URL(authorizeUrl(env, "https://atteo.dev/auth/callback", "st", { organizationId: "org_1", provider: APPLE_OAUTH_PROVIDER }));
    expect(sso.searchParams.get("organization_id")).toBe("org_1");
    expect(sso.searchParams.get("provider")).toBeNull();
  });

  it("turns the Apple redirect on only when WORKOS_APPLE_OAUTH is exactly 1", () => {
    expect(loginProvider("AppleOAuth", {})).toBe("unavailable");
    expect(loginProvider("AppleOAuth", { WORKOS_APPLE_OAUTH: "" })).toBe("unavailable");
    expect(loginProvider("AppleOAuth", { WORKOS_APPLE_OAUTH: "true" })).toBe("unavailable");
    expect(loginProvider("AppleOAuth", { WORKOS_APPLE_OAUTH: "1" })).toBe("apple");
    expect(loginProvider(null, { WORKOS_APPLE_OAUTH: "1" })).toBe("authkit");
    expect(loginProvider("GoogleOAuth", { WORKOS_APPLE_OAUTH: "1" })).toBe("authkit");
    expect(loginProvider("GitHubOAuth", { WORKOS_APPLE_OAUTH: "1" })).toBe("authkit");
    expect(loginProvider("authkit", {})).toBe("authkit");
    expect(loginProvider("AppleOAuth ", { WORKOS_APPLE_OAUTH: "1" })).toBe("authkit");
  });

  it("forwards Apple from the app's authorize request and drops it for everyone else", () => {
    const back = "/oauth/authorize?client_id=oc_1&redirect_uri=atteo%3A%2F%2Fauth&scope=person&provider=AppleOAuth";
    expect(oauthSignInLocation(back, "AppleOAuth", "person")).toBe(`/auth/login?return=${encodeURIComponent(back)}&provider=AppleOAuth`);
    expect(oauthSignInLocation(back, "AppleOAuth", "board person")).toBe(`/auth/login?return=${encodeURIComponent(back)}&provider=AppleOAuth`);
    expect(oauthSignInLocation(back, "AppleOAuth", "board")).toBe(`/auth/login?return=${encodeURIComponent(back)}`);
    expect(oauthSignInLocation(back, "AppleOAuth", null)).toBe(`/auth/login?return=${encodeURIComponent(back)}`);
    expect(oauthSignInLocation(back, null, "person")).toBe(`/auth/login?return=${encodeURIComponent(back)}`);
    expect(oauthSignInLocation(back, "GoogleOAuth", "person")).toBe(`/auth/login?return=${encodeURIComponent(back)}`);
    expect(oauthSignInLocation("//evil.example/steal", "AppleOAuth", "person")).toBe("/auth/login?return=%2F&provider=AppleOAuth");
  });

  it("keeps Apple on a restarted app sign-in, and ignores it on an agent connector's return path", () => {
    const appReturn = "/oauth/authorize?scope=person&provider=AppleOAuth";
    expect(requestedLoginProvider(null, appReturn)).toBe("AppleOAuth");
    expect(requestedLoginProvider("AppleOAuth", "/")).toBe("AppleOAuth");
    expect(requestedLoginProvider(null, "/oauth/authorize?scope=board&provider=AppleOAuth")).toBeNull();
    expect(requestedLoginProvider("GoogleOAuth", appReturn)).toBe("GoogleOAuth");
    expect(requestedLoginProvider(null, "//evil.example?scope=person&provider=AppleOAuth")).toBeNull();
  });

  it("names Sign in with Apple on the privacy page, and the repo holds no Apple key or opt-in flag", async () => {
    const html = await legalPage("privacy").text();
    expect(html).toContain("Sign in with Apple");
    expect(html).toContain("private relay");
    expect(html).toContain("Google, GitHub");

    const wrangler = readFileSync("wrangler.jsonc", "utf8");
    expect(wrangler).not.toMatch(/"WORKOS_APPLE_OAUTH"\s*:/);
    expect(wrangler).not.toMatch(/BEGIN (?:RSA |EC )?PRIVATE KEY/);

    const doc = readFileSync("docs/SIGN_IN_WITH_APPLE.md", "utf8");
    for (const w of ["Services ID", "Team ID", "Key ID", "api.workos.com", "WORKOS_APPLE_OAUTH", "503", "Hide My Email", "privaterelay.appleid.com"]) {
      expect(doc).toContain(w);
    }
  });
});
