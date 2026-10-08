import { describe, expect, it } from "vitest";
import { CONNECT_TILE_NAMES, connectTiles } from "../src/html";
import { AGENT_LOGO_CSS } from "../src/agent-logos";
import htmlSource from "../src/html.ts?raw";
import agentWebSource from "../src/agentWeb.ts?raw";
import landing from "../landing/jxn-static/landing.html?raw";

// "Connect an agent" covers every agent the landing shows (vedu #6558): its LOGOS list, one per brand mark.
describe("Connect an agent's tiles", () => {
  const logos = [...(/LOGOS = \[(.*?)\];/.exec(landing)?.[1] ?? "").matchAll(/\['([^']+)'/g)].map((m) => m[1]);

  it("have a tile for every agent on the landing, A–Z with Any other agent last", () => {
    expect(logos.length).toBeGreaterThanOrEqual(35);
    const names = CONNECT_TILE_NAMES.map((n) => ` ${n.toLowerCase()} `);
    for (const l of logos) expect(names.some((n) => n.includes(` ${l} `)), l).toBe(true);
    const az = CONNECT_TILE_NAMES.slice(0, -1);
    expect(az).toEqual([...az].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
    expect(CONNECT_TILE_NAMES.at(-1)).toBe("Any other agent");
  });

  it("show the usual thirteen, the rest behind Show all agents, each with a logo the stylesheet draws", () => {
    const html = connectTiles();
    const tiles = [...html.matchAll(/class="cn-tile( cn-more)?"[^>]*>(<i class="cn-logo" data-(lg|li)="([a-z0-9]+)")/g)];
    expect(tiles.length).toBe(CONNECT_TILE_NAMES.length);
    expect(tiles.filter((t) => !t[1]).length).toBe(13);
    expect(html).toContain("data-cn-all");
    for (const t of tiles) expect(AGENT_LOGO_CSS).toContain(`i.cn-logo[data-${t[3]}=${t[4]}]{`);
  });

  it("Instinct copies the browser-agent sign-in message, with this server's address", () => {
    expect(connectTiles()).toMatch(/data-cn-say="instinct">[^]*?<b>Instinct<\/b>/);
    const instruction = /export const AGENT_INSTRUCTION = ("[^"]+");/.exec(agentWebSource)?.[1];
    expect(instruction).toContain("sign-in link");
    expect(htmlSource).toContain(`const BROWSER_AGENT_SAY = ${instruction};`);
    expect(htmlSource).toContain("instinct:${JSON.stringify(BROWSER_AGENT_SAY)}.split('https://atteo.dev').join(location.origin)");
  });
});
