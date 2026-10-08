import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectIntegration, disconnectIntegration, type IntegrationDeps, listIntegrations, type Opt } from "../cli/src/integrations";

// atteo connect / connect linear / disconnect linear (vedu #6508/#6512), with the server answered by a stub.
class CliError extends Error {}
const B = "b_folderboard1";
const LINEAR = `/api/integrations/linear?board=${B}`;
const SLACK = `/api/integrations/slack?board=${B}`;
const NOTION = `/api/integrations/notion?board=${B}`;
const TEAMS = `/api/integrations/teams?board=${B}`;
const teamsLinked = { linked: true, active: true, team_name: "Acme Team", channel_name: "eng", created_by: "vedu", linked_by_name: "Jane Doe", created_at: 1 };
const DISCORD = `/api/integrations/discord?board=${B}`;
const discordLinked = { linked: true, active: true, guild_id: "g1", channel_id: "c1", created_by: "ann", linked_by_name: "Ann", created_at: 1 };
const notionLinked = { linked: true, active: true, workspace: { id: "w1", name: "Acme HQ" }, created_by: "ann", created_at: 1, published: 2, imported: 1 };
const linked = { linked: true, ready: true, org: { id: "o1", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engineering" }, project: { id: "p1", name: "Checkout" }, created_by: "ann", created_at: 1, issues: 3 };

let calls: { method: string; path: string }[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};
let out: string[] = [];
const printed = () => out.join("\n");
const deps = (over: Partial<IntegrationDeps> = {}): IntegrationDeps => ({
  api: async (method, path) => {
    calls.push({ method, path });
    const a = answers[`${method} ${path}`];
    if (!a) throw Object.assign(new CliError(`no stub for ${method} ${path}`), { status: 500 });
    if (a.status >= 400) throw Object.assign(new CliError((a.body as { error?: string }).error ?? `The server answered ${a.status}.`), { status: a.status });
    return a.body;
  },
  base: () => "https://atteo.test",
  board: (opt: Opt) => (typeof opt.board === "string" ? opt.board : B),
  say: (s) => void out.push(s),
  fail: (m) => new CliError(m),
  open: vi.fn(),
  ...over,
});

beforeEach(() => {
  calls = [];
  answers = {};
  out = [];
});

describe("atteo connect (the list)", () => {
  it("lists Linear, Slack, Notion, Microsoft Teams and Discord with their status; nothing is coming soon", async () => {
    answers[`GET ${LINEAR}`] = { status: 200, body: linked };
    answers[`GET ${NOTION}`] = { status: 200, body: notionLinked };
    answers[`GET ${TEAMS}`] = { status: 200, body: teamsLinked };
    answers[`GET ${DISCORD}`] = { status: 200, body: discordLinked };
    answers[`GET ${SLACK}`] = { status: 200, body: { connected: true, channels: [{ name: "eng", lane: "decisions", paused: null }, { name: "old", lane: "everything", paused: "archived" }] } };
    await listIntegrations({}, deps());
    const p = printed();
    expect(p).toContain(`Integrations on ${B}:`);
    expect(p).toMatch(/linear\s+connected · Engineering \(ENG\) · project Checkout · by ann · 3 issues/);
    expect(p).toMatch(/slack\s+connected · #eng, #old \(paused\)/);
    expect(p).toMatch(/notion\s+connected · Acme HQ · by ann · 2 published, 1 imported/);
    expect(p).toMatch(/teams\s+connected · eng in Acme Team · by vedu/);
    expect(p).toMatch(/discord\s+connected · by ann\n/);
    expect(p).not.toMatch(/g1|c1/); // no Discord ids
    expect(p).not.toContain("coming soon");
  });
  it("says when an integration isn't set up on the server, or isn't connected", async () => {
    answers[`GET ${LINEAR}`] = { status: 503, body: { error: "Linear isn't set up yet" } };
    answers[`GET ${SLACK}`] = { status: 200, body: { connected: false, channels: [] } };
    answers[`GET ${NOTION}`] = { status: 503, body: { error: "Notion isn't set up yet" } };
    answers[`GET ${TEAMS}`] = { status: 503, body: { error: "Microsoft Teams isn't set up yet" } };
    answers[`GET ${DISCORD}`] = { status: 200, body: { linked: false } };
    await listIntegrations({}, deps());
    expect(printed()).toMatch(/teams\s+not set up on this server yet/);
    expect(printed()).toMatch(/discord\s+not connected/);
    expect(printed()).toMatch(/linear\s+not set up on this server yet/);
    expect(printed()).toMatch(/notion\s+not set up on this server yet/);
    expect(printed()).toMatch(/slack\s+not connected/);
  });
  it("finds --board by name among your boards", async () => {
    answers["GET /api/me/boards"] = { status: 200, body: { boards: [{ id: "b_otherboard1", title: "Checkout rewrite" }] } };
    answers["GET /api/integrations/linear?board=b_otherboard1"] = { status: 200, body: { linked: false } };
    answers["GET /api/integrations/slack?board=b_otherboard1"] = { status: 503, body: { error: "Slack isn't set up yet" } };
    answers["GET /api/integrations/notion?board=b_otherboard1"] = { status: 200, body: { linked: false } };
    answers["GET /api/integrations/teams?board=b_otherboard1"] = { status: 200, body: { linked: false } };
    answers["GET /api/integrations/discord?board=b_otherboard1"] = { status: 200, body: { linked: false } };
    await listIntegrations({ board: "checkout REWRITE" }, deps());
    expect(printed()).toContain('Integrations on "Checkout rewrite" (b_otherboard1):');
    expect(printed()).toMatch(/linear\s+not connected/);
    await expect(listIntegrations({ board: "Nope" }, deps())).rejects.toThrow(/not on a board "Nope"/);
  });
  it("--json prints the server's objects", async () => {
    answers[`GET ${LINEAR}`] = { status: 200, body: linked };
    answers[`GET ${SLACK}`] = { status: 503, body: { error: "Slack isn't set up yet" } };
    answers[`GET ${NOTION}`] = { status: 200, body: notionLinked };
    answers[`GET ${TEAMS}`] = { status: 200, body: teamsLinked };
    answers[`GET ${DISCORD}`] = { status: 503, body: { error: "Discord isn't set up yet" } };
    await listIntegrations({ json: true }, deps());
    expect(JSON.parse(printed())).toEqual({ board: B, linear: linked, slack: { error: "Slack isn't set up yet", status: 503 }, notion: notionLinked, teams: teamsLinked, discord: { error: "Discord isn't set up yet", status: 503 }, coming_soon: [] });
  });
});

describe("atteo connect linear", () => {
  it("prints the start link and opens it (not with --no-open)", async () => {
    answers[`GET ${LINEAR}`] = { status: 200, body: { linked: false } };
    const open = vi.fn();
    await connectIntegration("linear", {}, deps({ open }));
    const url = `https://atteo.test/api/integrations/linear/start?board=${B}`;
    expect(printed()).toContain(url);
    expect(printed()).toContain("a board owner");
    expect(open).toHaveBeenCalledWith(url);
    out = [];
    await connectIntegration("linear", { "no-open": true, board: B }, deps({ open }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(printed()).toContain(url);
  });
  it("says it's already connected, and still gives the link to connect again", async () => {
    answers[`GET ${LINEAR}`] = { status: 200, body: linked };
    await connectIntegration("linear", { "no-open": true }, deps());
    expect(printed()).toContain("connected · Engineering (ENG)");
    expect(printed()).toContain("To connect again");
  });
  it("refuses when Linear isn't set up on the server, or you aren't on the board, and opens nothing", async () => {
    const open = vi.fn();
    answers[`GET ${LINEAR}`] = { status: 503, body: { error: "Linear isn't set up yet" } };
    await expect(connectIntegration("linear", {}, deps({ open }))).rejects.toThrow("Linear isn't set up on https://atteo.test yet.");
    answers[`GET ${LINEAR}`] = { status: 404, body: { error: "No such board." } };
    await expect(connectIntegration("linear", {}, deps({ open }))).rejects.toThrow(`You're not on board ${B}`);
    expect(open).not.toHaveBeenCalled();
  });
  it("Notion's link is its OAuth start, like Linear's", async () => {
    answers[`GET ${NOTION}`] = { status: 200, body: { linked: false } };
    const open = vi.fn();
    await connectIntegration("notion", {}, deps({ open }));
    const url = `https://atteo.test/api/integrations/notion/start?board=${B}`;
    expect(open).toHaveBeenCalledWith(url);
    expect(printed()).toContain("Open this link to connect Notion");
    answers[`GET ${NOTION}`] = { status: 503, body: { error: "Notion isn't set up yet" } };
    await expect(connectIntegration("notion", {}, deps({ open }))).rejects.toThrow("Notion isn't set up on https://atteo.test yet.");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("Discord's link is its start page (a one-time /atteo link code)", async () => {
    answers[`GET ${DISCORD}`] = { status: 200, body: { linked: false } };
    const open = vi.fn();
    await connectIntegration("discord", {}, deps({ open }));
    const url = `https://atteo.test/api/integrations/discord/start?board=${B}`;
    expect(open).toHaveBeenCalledWith(url);
    expect(printed()).toContain("Open this link to connect a Discord channel");
    expect(printed()).toContain("/atteo link <code>");
    out = [];
    answers[`GET ${DISCORD}`] = { status: 200, body: discordLinked };
    await connectIntegration("discord", { "no-open": true }, deps({ open }));
    expect(printed()).toContain("Discord on b_folderboard1: connected · by ann");
    expect(printed()).toContain("To move it to another channel");
    answers[`GET ${DISCORD}`] = { status: 503, body: { error: "Discord isn't set up yet" } };
    await expect(connectIntegration("discord", {}, deps({ open }))).rejects.toThrow("Discord isn't set up on https://atteo.test yet.");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("Slack's link is the owner's connect page; anything else is unknown", async () => {
    answers[`GET ${SLACK}`] = { status: 200, body: { connected: false, channels: [] } };
    const open = vi.fn();
    await connectIntegration("slack", {}, deps({ open }));
    expect(open).toHaveBeenCalledWith(`https://atteo.test/slack/connect?board=${B}`);
    expect(open).toHaveBeenCalledTimes(1);
    await expect(connectIntegration("jira", {}, deps({ open }))).rejects.toThrow(/Unknown integration "jira"/);
  });
});

describe("atteo connect teams / disconnect teams", () => {
  it("prints and opens the start page, where a board owner gets the code a team owner posts in the channel", async () => {
    answers[`GET ${TEAMS}`] = { status: 200, body: { linked: false } };
    const open = vi.fn();
    await connectIntegration("teams", {}, deps({ open }));
    const url = `https://atteo.test/api/integrations/teams/start?board=${B}`;
    expect(open).toHaveBeenCalledWith(url);
    expect(printed()).toContain("@Atteo link <code>");
    answers[`GET ${TEAMS}`] = { status: 503, body: { error: "Microsoft Teams isn't set up yet" } };
    await expect(connectIntegration("teams", {}, deps({ open }))).rejects.toThrow("Microsoft Teams isn't set up on https://atteo.test yet.");
  });
  it("disconnects with DELETE after a yes; a refused CLI login names the web panel", async () => {
    answers[`DELETE ${TEAMS}`] = { status: 200, body: { ok: true, linked: false } };
    const confirm = vi.fn(async () => true);
    await disconnectIntegration("teams", {}, deps({ confirm }));
    expect(confirm).toHaveBeenCalledWith(`Disconnect Microsoft Teams from ${B}? Its channel stops getting posts.`);
    expect(calls).toContainEqual({ method: "DELETE", path: TEAMS });
    expect(printed()).toContain(`Microsoft Teams is disconnected from ${B}.`);
    answers[`DELETE ${TEAMS}`] = { status: 403, body: { error: "Connecting Microsoft Teams is for people, signed in on Atteo. An agent's token can't." } };
    await expect(disconnectIntegration("teams", { yes: true }, deps())).rejects.toThrow(`https://atteo.test/b/${B}#integrations`);
  });
});

describe("atteo disconnect linear", () => {
  it("DELETEs the link after a yes", async () => {
    answers[`DELETE ${LINEAR}`] = { status: 200, body: { ok: true, linked: false } };
    const confirm = vi.fn(async () => true);
    await disconnectIntegration("linear", {}, deps({ confirm }));
    expect(confirm).toHaveBeenCalled();
    expect(calls).toContainEqual({ method: "DELETE", path: LINEAR });
    expect(printed()).toContain(`Linear is disconnected from ${B}.`);
  });
  it("changes nothing on a no; --yes skips the question", async () => {
    await expect(disconnectIntegration("linear", {}, deps({ confirm: async () => false }))).rejects.toThrow("Nothing changed.");
    expect(calls).toEqual([]);
    answers[`DELETE ${LINEAR}`] = { status: 200, body: { ok: true, linked: false } };
    const confirm = vi.fn(async () => false);
    await disconnectIntegration("linear", { yes: true }, deps({ confirm }));
    expect(confirm).not.toHaveBeenCalled();
    expect(calls).toContainEqual({ method: "DELETE", path: LINEAR });
  });
  it("a refused CLI login (people only) names the board's web panel", async () => {
    answers[`DELETE ${LINEAR}`] = { status: 403, body: { error: "Connecting Linear is for people, signed in on Atteo. An agent's token can't." } };
    await expect(disconnectIntegration("linear", { yes: true }, deps())).rejects.toThrow(`https://atteo.test/b/${B}#integrations`);
  });
  it("disconnects Notion the same way, after a yes", async () => {
    answers[`DELETE ${NOTION}`] = { status: 200, body: { ok: true, linked: false } };
    const confirm = vi.fn(async (q: string) => (expect(q).toContain("Pages already published stay in Notion"), true));
    await disconnectIntegration("notion", {}, deps({ confirm }));
    expect(confirm).toHaveBeenCalled();
    expect(calls).toContainEqual({ method: "DELETE", path: NOTION });
    expect(printed()).toContain(`Notion is disconnected from ${B}.`);
    answers[`DELETE ${NOTION}`] = { status: 503, body: { error: "Notion isn't set up yet" } };
    await expect(disconnectIntegration("notion", { yes: true }, deps())).rejects.toThrow("Notion isn't set up on https://atteo.test yet.");
  });
  it("disconnects Discord the same way, after a yes", async () => {
    answers[`DELETE ${DISCORD}`] = { status: 200, body: { ok: true, linked: false } };
    const confirm = vi.fn(async (q: string) => (expect(q).toContain("Its channel stops getting posts"), true));
    await disconnectIntegration("discord", {}, deps({ confirm }));
    expect(confirm).toHaveBeenCalled();
    expect(calls).toContainEqual({ method: "DELETE", path: DISCORD });
    expect(printed()).toContain(`Discord is disconnected from ${B}.`);
    answers[`DELETE ${DISCORD}`] = { status: 403, body: { error: "Only ann (who connected it) or a board owner can disconnect Discord." } };
    await expect(disconnectIntegration("discord", { yes: true }, deps())).rejects.toThrow(`https://atteo.test/b/${B}#integrations`);
  });
  it("needs a name; Slack points at its owner page", async () => {
    await expect(disconnectIntegration(undefined, {}, deps())).rejects.toThrow(/Usage: atteo disconnect linear/);
    const open = vi.fn();
    await disconnectIntegration("slack", {}, deps({ open }));
    expect(open).toHaveBeenCalledWith(`https://atteo.test/slack/board/${B}`);
    expect(calls).toEqual([]);
  });
});
