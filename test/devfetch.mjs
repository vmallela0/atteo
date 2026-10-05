// wrangler dev's ProxyWorker sits between a test and the local Worker. When its connection to workerd drops it retries
// GET and HEAD itself, but a POST fails alone (workers-sdk #15451, #5095): the test gets wrangler's own error instead of
// the Worker's answer, and a step fails for no reason of ours (#3673; 'Network connection lost' in gate handoffs).
// devFetch retries such a request once, logging it, and only against a local server: never production, and never a
// response the Worker itself sent (ours are JSON or pages, never these texts).

export const PROXY_FAILURES = [/^Error: Network connection lost/, /^Your worker restarted mid-request/];
export const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;
// The same drop one layer down: the proxy closes the socket before answering, and Node's fetch throws "fetch failed".
// Refused connections aren't among them: that's a server that isn't there, and a retry wouldn't help.
const SOCKET_DROPS = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const socketDrop = (e) => e instanceof TypeError && SOCKET_DROPS.has(e.cause?.code);

/** Was this wrangler dev's proxy failing, rather than the Worker answering? */
export async function isProxyFailure(res) {
  if (res.status < 500) return false;
  const text = await res.clone().text().catch(() => "");
  return PROXY_FAILURES.some((re) => re.test(text));
}

/** A fetch that retries wrangler dev's dropped requests once (local servers only). `log` hears about each retry. */
export function devFetch(realFetch, log = (m) => console.log(m)) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const local = LOCAL.test(url);
    const resendable = !init?.body || typeof init.body === "string" || init.body instanceof URLSearchParams; // not a stream
    const again = async (why) => {
      log(`      (wrangler dev dropped ${init?.method ?? "GET"} ${new URL(url).pathname}: ${why}; retried once)`);
      await new Promise((r) => setTimeout(r, 100));
      return realFetch(input, init);
    };
    let res;
    try {
      res = await realFetch(input, init);
    } catch (e) {
      if (local && resendable && socketDrop(e)) return again(e.cause.code);
      throw e;
    }
    if (local && resendable && (await isProxyFailure(res))) return again(res.status);
    return res;
  };
}

/** The same retry inside a browser page (#3808), for the pages a browser check drives: test/browser/lib/proxyretry.mjs
 * adds it to every context as an init script, so it is self-contained and gets the patterns as sources
 * (`{failures: PROXY_FAILURES sources, local: LOCAL source}`). Only a string or URL with a body it can send again. */
export function retryPageFetch(rules, w = globalThis, log = (m) => console.warn(m)) {
  if (w.__retryPageFetch) return;
  w.__retryPageFetch = true;
  const failures = rules.failures.map((s) => new RegExp(s)), local = new RegExp(rules.local), realFetch = w.fetch;
  w.fetch = async (input, init) => {
    const body = init?.body;
    const resendable = (typeof input === "string" || input instanceof URL) && (body == null || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body));
    const url = resendable ? new URL(String(input), w.location?.href) : null;
    const res = await realFetch(input, init);
    if (!url || !local.test(url.href) || res.status < 500) return res;
    const text = await res.clone().text().catch(() => "");
    if (!failures.some((re) => re.test(text))) return res;
    log(`(wrangler dev dropped ${init?.method ?? "GET"} ${url.pathname}: ${res.status}; retried once)`);
    await new Promise((r) => setTimeout(r, 100));
    return realFetch(input, init);
  };
}
