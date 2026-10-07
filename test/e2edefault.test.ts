import { describe, expect, it } from "vitest";
import { e2eDefault, encryptsLocally, mcpCreateEncrypted } from "../src/e2edefault";

describe("E2E by default (E2E design §7, Phase 1c)", () => {
  it("is off unless E2E_DEFAULT says so", () => {
    expect(e2eDefault({})).toBe(false);
    expect(e2eDefault({ E2E_DEFAULT: "" })).toBe(false);
    expect(e2eDefault({ E2E_DEFAULT: "0" })).toBe(false);
    for (const v of ["1", "true", "on", " TRUE "]) expect(e2eDefault({ E2E_DEFAULT: v })).toBe(true);
  });

  it("knows the CLI's local MCP proxy, which encrypts on the person's machine", () => {
    expect(encryptsLocally("agent-board-cli/0.42.0")).toBe(true);
    expect(encryptsLocally("atteo-cli/2")).toBe(false); // the plain commands go through the sealed routes themselves
    expect(encryptsLocally("Claude-User")).toBe(false);
    expect(encryptsLocally(null)).toBe(false);
  });

  it("an MCP create_board: explicit wins; the default encrypts for local agents, and for hosted ones only once they can read as a visible reader", () => {
    const on = { E2E_DEFAULT: "1" };
    expect(mcpCreateEncrypted({}, undefined, true, true)).toBe(false); // off: today's behaviour
    expect(mcpCreateEncrypted({}, true, false, false)).toBe(true);
    expect(mcpCreateEncrypted(on, false, true, true)).toBe(false); // "Readable by Atteo's servers", chosen explicitly
    expect(mcpCreateEncrypted(on, undefined, true, false)).toBe(true);
    expect(mcpCreateEncrypted(on, undefined, false, false)).toBe(false); // a hosted connector can't read it yet
    expect(mcpCreateEncrypted(on, undefined, false, true)).toBe(true);
  });
});
