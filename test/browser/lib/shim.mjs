// Preloaded by run.mjs into each check (NODE_OPTIONS=--import) when the runner shares Chromium: chromium.launch() connects
// to a browser the runner already started (chromium.launchServer) instead of starting a new one, so each check gets its
// own contexts in a shared Chromium (~20 ms instead of ~1 s per launch) without changing the check. browser.close() on a
// connected browser closes only that check's contexts. Anything it doesn't recognise falls back to a real launch.
// Env (set by run.mjs): BROWSER_SHIM_MAIN (the check's path; a no-op in any other process, e.g. a CLI the check spawns),
// BROWSER_SHIM_WS (JSON {default, scrollbars}: ws endpoints), BROWSER_SHIM_EXE (the executable the shared browsers run).
// Adapted from opus-e's fastgate shim.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const main = process.env.BROWSER_SHIM_MAIN;
if (process.env.BROWSER_SHIM_WS && main && process.argv[1] && same(process.argv[1], main)) {
  const require = createRequire(main);
  const { chromium } = require("playwright-core");
  const ws = JSON.parse(process.env.BROWSER_SHIM_WS), exe = process.env.BROWSER_SHIM_EXE;
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (opts = {}) => {
    const { executablePath, ignoreDefaultArgs, headless, ...rest } = opts;
    let key = null;
    if (Object.keys(rest).length === 0 && headless !== false && (!executablePath || !exe || same(executablePath, exe))) {
      if (!ignoreDefaultArgs) key = "default";
      else if (Array.isArray(ignoreDefaultArgs) && ignoreDefaultArgs.length === 1 && ignoreDefaultArgs[0] === "--hide-scrollbars") key = "scrollbars";
    }
    if (!key || !ws[key]) return launch(opts);
    try { return await chromium.connect(ws[key], { timeout: 15000 }); }
    catch (e) { process.stderr.write(`browser shim: connect failed (${e.message.split("\n")[0]}), launching\n`); return launch(opts); }
  };
}
