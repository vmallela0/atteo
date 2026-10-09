// One of many processes changing the same JSON file at once (test/jsonState.test.mjs). Waits for <go>, then adds its own
// key and bumps it `rounds` times, each a separate read-modify-write. `reader` instead reads the file until <go>.done
// exists and prints how many reads saw a file that didn't parse; `scribble` keeps half-writing it. (The CLI's old read → change → writeFileSync, run the
// same way, lost entries and once left a file that didn't parse.)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { updateJson } from "../cli/src/jsonState.ts";

const [mode, file, go, key, rounds] = process.argv.slice(2);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (!existsSync(go)) nap(2);

if (mode === "reader") {
  let bad = 0;
  while (!existsSync(`${go}.done`)) {
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") bad++;
    }
  }
  process.stdout.write(String(bad));
} else if (mode === "scribble") {
  // An older CLI mid-write, again and again: different half-written bytes each time, until <go>.done.
  for (let i = 0; !existsSync(`${go}.done`); i++) {
    writeFileSync(file, `{"k${i}": {"id": "as_`);
    nap(3);
  }
} else {
  const pad = "x".repeat(2000); // big enough that a plain write isn't one syscall's worth
  for (let i = 1; i <= Number(rounds); i++) {
    updateJson(file, {}, (map) => {
      map[key] = { n: i, pad };
    }, { space: 2 });
  }
}
