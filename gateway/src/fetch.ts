// fetch() that refuses a write containing a credential (and, later, a denied action)
// before the request is sent. Reads pass through.

import { inspectWrite, isWriteMethod, blockedLocally } from "./filter";
import { allowAll, type ActionPolicy } from "./policy";
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
