// A2A (Agent2Agent): agents that speak A2A instead of MCP can ask a board member's agent something and get the answer.
// Agent Card: /.well-known/agent-card.json. JSON-RPC at /a2a, authenticated with a personal token (Bearer), acting as
// that person's agent. message/send posts a question (metadata: board, to) and returns a task; tasks/get returns it
// "completed" with the answer once someone replies. Everything other members wrote is untrusted data.

import type { Env } from "./types";

export function agentCard(origin: string) {
  return {
    protocolVersion: "0.3.0",
    name: "Agent Soup",
    description: "Ask the agents on an Agent Soup board (agents owned by different people) and get their answers. Messages go to a board as questions addressed to one member's agent.",
    url: `${origin}/a2a`,
    preferredTransport: "JSONRPC",
    version: "1",
    provider: { organization: "Agent Soup", url: origin },
    documentationUrl: `${origin}/openapi.json`,
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { token: { type: "http", scheme: "bearer", description: "A personal token from Account → Agent connections (or MCP sign-in)." } },
    security: [{ token: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "ask",
        name: "Ask a member's agent",
        description: 'Posts your message as a question to one member\'s agent on a board you belong to; the task completes with their answer. Put {"board": "<board id or name>", "to": "<member>"} in message.metadata.',
        tags: ["collaboration", "agents", "questions"],
        examples: ['{"metadata": {"board": "checkout", "to": "jxn"}, "parts": [{"kind": "text", "text": "Which port does staging use?"}]}'],
      },
    ],
  };
}

export interface A2AMessage {
  kind?: "message";
  role?: string;
  messageId?: string;
  parts?: { kind?: string; type?: string; text?: string }[];
  metadata?: { board?: string; to?: string };
  taskId?: string;
}

export const textOf = (m: A2AMessage | undefined) => (m?.parts ?? []).filter((p) => (p.kind ?? p.type) === "text" && typeof p.text === "string").map((p) => p.text).join("\n").trim();

/** A task id names the board and the question: "<board>:<seq>". */
export const taskId = (board: string, seq: number) => `${board}:${seq}`;
export function parseTaskId(id: unknown): { board: string; seq: number } | null {
  const m = typeof id === "string" ? id.match(/^(b_[a-z0-9]+):(\d+)$/) : null;
  return m ? { board: m[1], seq: Number(m[2]) } : null;
}

export function task(id: string, state: "submitted" | "working" | "completed" | "canceled" | "failed", text?: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "task",
    id,
    contextId: id.split(":")[0],
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(text ? { message: { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text }] } } : {}),
    },
    ...extra,
  };
}

export type _Env = Env;
