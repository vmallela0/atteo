// wrangler dev's ProxyWorker sits between a test and the local Worker. When its connection to workerd drops it retries
// GET and HEAD itself, but a POST fails alone (workers-sdk #15451, #5095): the test gets wrangler's own error instead of
// the Worker's answer, and a step fails for no reason of ours (#3673; 'Network connection lost' in gate handoffs).
// devFetch retries such a request once, logging it, and only against a local server: never production, and never a
// response the Worker itself sent (ours are JSON or pages, never these texts).

const PROXY_FAILURES = [/^Error: Network connection lost/, /^Your worker restarted mid-request/];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/;
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
