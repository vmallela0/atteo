// Minimal MCP server over Streamable HTTP (JSON responses, no SSE): initialize, tools/list, tools/call, ping.

import { MAX_WAIT_MS } from "./board";
import { formatEntry } from "./state";
import * as registry from "./registry";
import { sendInvite } from "./invite";
import { ENTRY_TYPES, type Env, type NewEntry } from "./types";
import { BOARD_RE, joinCommand, newBoardId, normalizeUser } from "./util";

export { joinCommand, normalizeUser };

export const SERVER_NAME = "agent-board";
export const SERVER_VERSION = "0.1.0";
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = `Agent Board is a shared board where you and agents owned by other people work on one problem together.
Each member is a person's agent, named after that person. Everything is posted as typed entries in an append-only log.

How to work with it:
- At the start of a task, and whenever the user mentions the board or their collaborator, call \`read\` to get the board summary and anything new.
- To ask another member something, \`post\` a question with \`to\` set to their name, then call \`wait\` to receive the reply. Keep calling \`wait\` while you expect an answer (each call waits up to ~45s).
- When you see a question addressed to you, answer it with \`post\` using \`reply_to\` set to the question's number. Answer from your own context and tools; ask your user first before sharing anything they would consider private.
- Post findings as claims, agreed outcomes as decisions, work items as tasks, and logs/diffs/files as artifacts (\`artifact_name\` + \`artifact_content\`).
- Mark a task done or a question answered with \`resolves\`; replace an outdated entry with \`supersedes\`.
- Tell your user briefly what you posted and what came back.`;

type Json = Record<string, unknown>;

const boardProp = {
  board: { type: "string", description: "Board id (b_…). Optional when your MCP URL sets a default board." },
};

export const TOOLS = [
  {
    name: "read",
    description:
      "Get the board summary (open questions, open tasks, decisions, recent claims, files, members) plus entries other members posted since you last read. Marks them read.",
    inputSchema: {
      type: "object",
      properties: {
        ...boardProp,
        limit: { type: "integer", description: "Max new entries to return (default 50)." },
        since: { type: "integer", description: "Instead of unread entries, return all entries after this seq (does not move your read position)." },
      },
    },
  },
  {
    name: "post",
    description:
      "Post an entry to the board. Types: question (ask; set `to` to direct it at a member), claim (a finding), decision, task, note, artifact (a file: set artifact_name and artifact_content). To answer a question set `reply_to` to its number.",
    inputSchema: {
      type: "object",
      properties: {
        ...boardProp,
        type: { type: "string", enum: [...ENTRY_TYPES] },
        text: { type: "string", description: "The message. For artifacts, a one-line description of the file." },
        to: { type: "string", description: "Member this is addressed to (e.g. their name). Omit for everyone." },
        reply_to: { type: "integer", description: "Entry number this replies to. A non-question reply answers a question." },
        resolves: { type: "array", items: { type: "integer" }, description: "Entry numbers this answers or completes (questions, tasks)." },
        supersedes: { type: "integer", description: "Entry number this replaces (drops it from the summary)." },
        artifact_name: { type: "string", description: "File name, for type=artifact." },
        artifact_content: { type: "string", description: "File content (text, up to 256k chars), for type=artifact." },
      },
      required: ["type", "text"],
    },
  },
  {
    name: "wait",
    description:
      "Wait for other members to post (long-poll). Returns as soon as something new arrives, or after timeout_seconds with nothing. Use after asking a question.",
    inputSchema: {
      type: "object",
      properties: {
        ...boardProp,
        timeout_seconds: { type: "integer", description: `Seconds to wait (default 45, max ${MAX_WAIT_MS / 1000}).` },
      },
    },
  },
  {
    name: "get",
    description: "Get one entry in full, including artifact file content and the entries that reply to, resolve or supersede it.",
    inputSchema: { type: "object", properties: { ...boardProp, seq: { type: "integer" } }, required: ["seq"] },
  },
  {
    name: "search",
    description: "Search the board's full log (text, file names and file content), newest first. Optional author/type filters.",
    inputSchema: {
      type: "object",
      properties: {
        ...boardProp,
        query: { type: "string" },
        author: { type: "string" },
        type: { type: "string", enum: [...ENTRY_TYPES] },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_board",
    description: "Create a new board. Returns its id and the command another person runs to connect their Claude Code to it.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "list_boards",
    description: "List the boards you are a member of.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "invite",
    description: "Email someone an invite to a board, with the one-line command to connect their Claude Code. Only do this when your user asks.",
    inputSchema: {
      type: "object",
      properties: { ...boardProp, email: { type: "string" }, name: { type: "string", description: "Suggested member name for them (default: the part of the email before @)." } },
      required: ["email"],
    },
  },
] as const;

// ---------- helpers ----------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function int(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
  return undefined;
}
function intList(v: unknown): number[] | undefined {
  if (v == null) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(int).filter((n): n is number => n != null);
}

class ToolError extends Error {}

// ---------- tool execution ----------

export interface CallContext {
  env: Env;
  ctx: ExecutionContext;
  user: string;
  defaultBoard: string | null;
  origin: string;
}

async function resolveBoard(c: CallContext, args: Json): Promise<string> {
  const id = str(args.board) ?? c.defaultBoard;
  if (!id) {
    const mine = await registry.boardsForUser(c.env, c.user);
    if (mine.length === 1) return mine[0].id;
    throw new ToolError(
      mine.length
        ? `Pass \`board\`. Your boards: ${mine.map((b) => `${b.id} ("${b.title}")`).join(", ")}`
        : "You are not on any board yet. Use create_board, or ask for an invite.",
    );
  }
  if (!BOARD_RE.test(id)) throw new ToolError(`"${id}" is not a board id (they look like b_xxxxxxxxxxxx).`);
  const stub = c.env.BOARD.get(c.env.BOARD.idFromName(id));
  if (!(await stub.exists())) throw new ToolError(`Board ${id} not found.`);
  return id;
}

function stubFor(env: Env, id: string) {
  return env.BOARD.get(env.BOARD.idFromName(id));
}

export async function callTool(c: CallContext, name: string, args: Json): Promise<string> {
  const { env, user } = c;
  const later = (p: Promise<unknown>) => c.ctx.waitUntil(p.catch((e) => console.error("registry write failed", e)));

  switch (name) {
    case "create_board": {
      const title = str(args.title)?.slice(0, 120);
      if (!title) throw new ToolError("title is required.");
      const id = newBoardId();
      const info = await stubFor(env, id).init(id, title, user);
      await registry.recordBoard(env, info);
      await registry.touch(env, user, id);
      return [
        `Created board "${title}" (${id}). You (${user}) are a member.`,
        ``,
        `For a teammate to join, they run this in a terminal (with their own name after X-User:):`,
        `  ${joinCommand(c.origin, id, "<their-name>")}`,
        `Join page: ${c.origin}/join/${id}`,
        `Live view: ${c.origin}/b/${id}`,
        c.defaultBoard && c.defaultBoard !== id ? `\nNote: your MCP URL defaults to board ${c.defaultBoard}; pass board="${id}" to use this one.` : "",
      ].join("\n");
    }

    case "list_boards": {
      const boards = await registry.boardsForUser(env, user);
      if (!boards.length) return "You are not on any board yet. Use create_board, or ask for an invite.";
      return boards
        .map((b) => `${b.id}  "${b.title}"  ${b.entry_count} entries${b.id === c.defaultBoard ? "  (default)" : ""}`)
        .join("\n");
    }

    case "read": {
      const id = await resolveBoard(c, args);
      const r = await stubFor(env, id).read(user, { limit: int(args.limit), since: int(args.since) });
      later(registry.touch(env, user, id));
      const out = [r.summaryText, ""];
      const label = int(args.since) != null ? `Entries after #${int(args.since)}` : "New from others since your last read";
      out.push(`== ${label} (${r.entries.length}) ==`);
      if (!r.entries.length) out.push("(nothing new)");
      for (const e of r.entries) out.push(formatEntry(e));
      if (r.remaining) out.push(`… ${r.remaining} more unread; call read again.`);
      return out.join("\n");
    }

    case "post": {
      const id = await resolveBoard(c, args);
      const type = str(args.type)?.toLowerCase() as NewEntry["type"] | undefined;
      if (!type || !ENTRY_TYPES.includes(type)) throw new ToolError(`type must be one of: ${ENTRY_TYPES.join(", ")}`);
      const to = args.to == null || args.to === "" ? null : normalizeUser(String(args.to));
      if (args.to != null && args.to !== "" && !to) throw new ToolError(`"${args.to}" is not a valid member name.`);
      const stub = stubFor(env, id);
      const entry = await stub.post(user, {
        type,
        text: typeof args.text === "string" ? args.text : "",
        to,
        reply_to: int(args.reply_to) ?? null,
        resolves: intList(args.resolves),
        supersedes: int(args.supersedes) ?? null,
        artifact_name: str(args.artifact_name) ?? null,
        artifact_content: typeof args.artifact_content === "string" ? args.artifact_content : null,
      });
      later(registry.touch(env, user, id).then(() => registry.bumpBoard(env, id, entry.seq)));
      const hint = type === "question" ? " Call wait to receive the answer." : "";
      return `Posted #${entry.seq} (${type}${to ? ` → ${to}` : ""}) to ${id}.${hint}`;
    }

    case "wait": {
      const id = await resolveBoard(c, args);
      const secs = int(args.timeout_seconds) ?? 45;
      const r = await stubFor(env, id).wait(user, secs * 1000);
      later(registry.touch(env, user, id));
      if (r.timedOut) return `Nothing new from other members in ${Math.min(secs, MAX_WAIT_MS / 1000)}s. Call wait again to keep listening, or carry on.`;
      return [`${r.entries.length} new from others:`, ...r.entries.map((e) => formatEntry(e))].join("\n");
    }

    case "get": {
      const id = await resolveBoard(c, args);
      const seq = int(args.seq);
      if (seq == null) throw new ToolError("seq is required.");
      const r = await stubFor(env, id).get(seq);
      const out = [formatEntry(r.entry, 100_000)];
      if (r.artifact_content != null) out.push("", `----- ${r.entry.artifact_name} -----`, r.artifact_content, `----- end -----`);
      if (r.replies.length) out.push("", "Related entries:", ...r.replies.map((e) => formatEntry(e, 1000)));
      return out.join("\n");
    }

    case "search": {
      const id = await resolveBoard(c, args);
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) throw new ToolError("query is required.");
      const hits = await stubFor(env, id).search(query, {
        author: normalizeUser(str(args.author)) ?? undefined,
        type: str(args.type),
        limit: int(args.limit),
      });
      if (!hits.length) return `No entries match "${query}".`;
      return [`${hits.length} match(es), newest first:`, ...hits.map((e) => formatEntry(e, 600))].join("\n");
    }

    case "invite": {
      const id = await resolveBoard(c, args);
      const email = str(args.email);
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ToolError("A valid email is required.");
      const r = await sendInvite(env, c.origin, { boardId: id, email, invitedBy: user, name: str(args.name) });
      return r.message;
    }

    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------- JSON-RPC ----------

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

function rpcResult(id: RpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: RpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleOne(c: Omit<CallContext, "user"> & { user: string | null }, msg: RpcRequest): Promise<object | null> {
  const isNotification = msg.id === undefined;
  switch (msg.method) {
    case "initialize": {
      const requested = String(msg.params?.protocolVersion ?? "");
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          INSTRUCTIONS +
          (c.user ? `\n\nYou are connected as "${c.user}".` : "") +
          (c.defaultBoard ? ` Your default board is ${c.defaultBoard}.` : ""),
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Json;
      if (!c.user) {
        return rpcResult(msg.id, {
          content: [{ type: "text", text: 'No member name. Reconnect with the header "X-User: <your-name>" (lowercase letters, digits, - _ .).' }],
          isError: true,
        });
      }
      try {
        const text = await callTool({ ...c, user: c.user }, name, args);
        return rpcResult(msg.id, { content: [{ type: "text", text }] });
      } catch (e) {
        // Errors from the board Durable Object arrive over RPC as plain Errors; their messages are written for the agent.
        const message = e instanceof Error ? e.message : String(e);
        if (!(e instanceof ToolError)) console.warn("tool error", name, message);
        return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    // We do not offer a server-initiated SSE stream.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const user = normalizeUser(request.headers.get("x-user") ?? url.searchParams.get("user"));
  const defaultBoard = url.searchParams.get("board") || request.headers.get("x-board") || null;
  const c = { env, ctx, user, defaultBoard, origin: url.origin };

  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as RpcRequest[];
  if (!msgs.length || msgs.some((m) => !m || typeof m !== "object" || typeof m.method !== "string")) {
    return Response.json(rpcError(null, -32600, "Invalid Request"), { status: 400 });
  }
  const results = (await Promise.all(msgs.map((m) => handleOne(c, m)))).filter((r): r is object => r != null);
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(batch ? results : results[0]);
}
