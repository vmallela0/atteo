// Harness action policy: the hook a later slice uses to refuse shell, file, and MCP
// actions that sit outside a room's charter (GAPS P0 #7) or need a person.
// This slice only defines the shape; `allowAll` lets every action through.

export type ActionKind = "http_write" | "shell" | "file_write" | "mcp_tool";

export interface ActionRequest {
  kind: ActionKind;
  method?: string;
  url?: string;
  /** Harness shell (future). */
  command?: string;
  /** Path on disk (future: charter "paths outside the room's scope"). */
  path?: string;
  tool?: string;
}

export interface ActionDecision {
  allow: boolean;
  reason?: string;
}

export interface ActionPolicy {
  allow(action: ActionRequest): ActionDecision | Promise<ActionDecision>;
}

/** First slice: no harness policy yet. Replace with charter/path rules later. */
export const allowAll: ActionPolicy = {
  allow: () => ({ allow: true }),
};
