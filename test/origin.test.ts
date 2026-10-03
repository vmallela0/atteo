import { describe, expect, it } from "vitest";
import { publicOrigin } from "../src/util";
import { authorizationServer, protectedResource } from "../src/oauth";
import { authorizeUrl, loginState, readLoginState } from "../src/auth";
import { agentCard } from "../src/a2a";
import { openapi } from "../src/openapi";
import { installScript } from "../src/install";

const env = { PUBLIC_URL: "https://atteo.dev" };
const u = (s: string) => new URL(s);

describe("publicOrigin", () => {
  it("uses PUBLIC_URL for the workers.dev host (what the atteo.dev proxy looks like inside the Worker) and for atteo.dev", () => {
    expect(publicOrigin(env, u("https://agent-board.vedu-mallela.workers.dev/auth/login"))).toBe("https://atteo.dev");
    expect(publicOrigin(env, u("https://atteo.dev/mcp"))).toBe("https://atteo.dev");
    expect(publicOrigin({ PUBLIC_URL: "https://atteo.dev/" }, u("https://agent-board.vedu-mallela.workers.dev/"))).toBe("https://atteo.dev");
  });

  it("keeps the request's own origin on this machine, so dev and tests never point at production", () => {
    for (const l of ["http://localhost:8808/auth/login", "http://127.0.0.1:8787/", "http://[::1]:8808/", "http://0.0.0.0:8808/", "http://app.localhost:8808/"]) {
      expect(publicOrigin(env, u(l))).toBe(u(l).origin);
    }
  });

  it("falls back to the request's origin when PUBLIC_URL isn't set (self-hosted deployments)", () => {
    expect(publicOrigin({}, u("https://board.example.workers.dev/x"))).toBe("https://board.example.workers.dev");
    expect(publicOrigin({ PUBLIC_URL: "" }, u("https://board.example.workers.dev/x"))).toBe("https://board.example.workers.dev");
  });

  it("puts the public origin in the sign-in callback and every piece of discovery metadata", () => {
    const o = publicOrigin(env, u("https://agent-board.vedu-mallela.workers.dev/auth/login"));
    const to = new URL(authorizeUrl({ WORKOS_CLIENT_ID: "client_x" } as never, `${o}/auth/callback`, "s"));
    expect(to.searchParams.get("redirect_uri")).toBe("https://atteo.dev/auth/callback");
    expect(authorizationServer(o)).toMatchObject({
      issuer: "https://atteo.dev",
      authorization_endpoint: "https://atteo.dev/oauth/authorize",
      token_endpoint: "https://atteo.dev/oauth/token",
      registration_endpoint: "https://atteo.dev/oauth/register",
    });
    expect(protectedResource(o)).toMatchObject({ resource: "https://atteo.dev/mcp", authorization_servers: ["https://atteo.dev"] });
    expect(agentCard(o).url).toBe("https://atteo.dev/a2a");
    expect(openapi(o).servers[0].url).toBe("https://atteo.dev");
    expect(installScript(o)).toContain("https://atteo.dev");

    const local = publicOrigin(env, u("http://localhost:8808/auth/login"));
    expect(authorizationServer(local).issuer).toBe("http://localhost:8808");
  });
});

describe("loginState", () => {
  it("carries the return path and whether sign-in was already restarted", () => {
    const ret = "/oauth/authorize?client_id=oc_1&redirect_uri=agentsoup%3A%2F%2Fauth&scope=person&é";
    const s = loginState(ret);
    expect(s).toMatch(/^[A-Za-z0-9_-]+\.0\.[A-Za-z0-9_-]+$/);
    expect(readLoginState(s)).toEqual({ restarted: false, ret });
    expect(readLoginState(loginState("/me", true))).toEqual({ restarted: true, ret: "/me" });
    expect(loginState("/")).not.toBe(loginState("/"));
  });

  it("reads anything else (an old-style or forged state) as a first attempt going home", () => {
    expect(readLoginState("forged")).toEqual({ restarted: false, ret: "/" });
    expect(readLoginState("a.1.%%%")).toEqual({ restarted: true, ret: "/" });
  });
});
