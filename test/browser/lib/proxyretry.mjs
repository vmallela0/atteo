// Preloaded by run.mjs into every browser check (NODE_OPTIONS=--import), #3808: wrangler dev's ProxyWorker drops a POST
// now and then (workers-sdk #15451), both the check's own (ops(), posts) and the ones its pages send. The check's fetch
// goes through devFetch, and every browser context gets retryPageFetch as an init script; both retry exactly the proxy's
// own error texts, once, against a local server only (test/devfetch.mjs). Not page.route: routing turns off the HTTP
// cache and sends every request through node. A page's retry is printed in the check's log like devFetch's.
// Env (set by run.mjs): BROWSER_CHECK, the check's path; a no-op in any other process, e.g. a CLI the check spawns.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { devFetch, retryPageFetch, PROXY_FAILURES, LOCAL } from "../../devfetch.mjs";

const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const main = process.env.BROWSER_CHECK;
if (main && process.argv[1] && same(process.argv[1], main)) {
  globalThis.fetch = devFetch(globalThis.fetch);
  const rules = { failures: PROXY_FAILURES.map((re) => re.source), local: LOCAL.source };
  const withRetry = async (ctx) => {
    await ctx.addInitScript(retryPageFetch, rules);
    ctx.on("console", (m) => { if (m.text().startsWith("(wrangler dev dropped")) console.log(`      ${m.text()}`); });
    return ctx;
  };
  const done = new WeakSet();
  // browser.newPage() makes its context with this.newContext(), so this covers both.
  const patch = (browser) => {
    if (done.has(browser)) return browser;
    done.add(browser);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => withRetry(await newContext(opts));
    return browser;
  };
  const pw = createRequire(main)("playwright-core");
  for (const type of [pw.chromium, pw.firefox, pw.webkit]) {
    for (const m of ["launch", "connect", "connectOverCDP"]) {
      if (typeof type[m] !== "function") continue;
      const f = type[m].bind(type);
      type[m] = async (...a) => patch(await f(...a));
    }
    const persistent = type.launchPersistentContext.bind(type);
    type.launchPersistentContext = async (...a) => withRetry(await persistent(...a));
  }
}
