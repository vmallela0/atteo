// fetch() that refuses a write containing a credential, or a write the action policy denies,
// before the request is sent. Reads pass through. Shell, file, and MCP tool actions are not
// HTTP writes: a harness decides those with reviewHarnessHook (policy.ts) before it runs them.

import { inspectWrite, isWriteMethod, blockedLocally } from "./filter";
import { allowAll, type ActionPolicy, type ActionRequest } from "./policy";
import type { SecretHit } from "../../src/secrets";

export class GatewayError extends Error {
  readonly code = "GATEWAY_BLOCKED";
  constructor(
    message: string,
    readonly hit?: SecretHit,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayOptions {
  fetch?: typeof fetch;
  policy?: ActionPolicy;
}

export interface Gateway {
  fetch: typeof fetch;
  inspect: typeof inspectWrite;
}

export function createGateway(opts: GatewayOptions = {}): Gateway {
  const inner = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const policy = opts.policy ?? allowAll;

  const gated: typeof fetch = async (input, init) => {
    const req = input instanceof Request && init == null ? input : new Request(input, init);
    if (isWriteMethod(req.method)) {
      const body = await req.clone().text();
      const hit = inspectWrite({ method: req.method, body });
      if (hit) throw new GatewayError(blockedLocally(hit), hit);
      const decision = await policy.allow({ kind: "http_write", method: req.method, url: req.url });
      if (!decision.allow) throw new GatewayError(decision.reason ?? "Blocked by action policy. Nothing was sent.");
    }
    return inner(req);
  };

  return { fetch: gated, inspect: inspectWrite };
}

export function gatewayFetch(opts: GatewayOptions = {}): typeof fetch {
  return createGateway(opts).fetch;
}

/** Refuse a harness action the policy denies. The error does not include the command, path, or secret. */
export async function enforceAction(policy: ActionPolicy, action: ActionRequest): Promise<void> {
  const decision = await policy.allow(action);
  if (!decision.allow) {
    const fallback = action.kind === "http_write" ? "Blocked by action policy. Nothing was sent." : "Blocked by action policy. Nothing was run.";
    throw new GatewayError(decision.reason ?? fallback);
  }
}
