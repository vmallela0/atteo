// A person at a terminal: runs the CLI in a pseudo-terminal and answers "y" to every [y/N] / [Y/n] prompt. Approving or
// trusting a device takes one (review #5567); an agent's plain spawn is refused.
import { spawn } from "node:child_process";

const PY = `
import os, pty, sys, json, re
argv = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
out = b""; n = 0
while True:
    try:
        c = os.read(fd, 4096)
    except OSError:
        break
    if not c:
        break
    out += c
    if len(re.findall(rb"\\[(y/N|Y/n)\\]", out)) > n:
        n += 1
        os.write(fd, b"y\\n")
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;

/** Resolves {code, out}: stdout and stderr together, as a terminal shows them. */
export const cliTty = (cli, args, { cwd, env }) =>
  new Promise((res) => {
    const p = spawn("python3", ["-c", PY, JSON.stringify(["node", cli, ...args])], { cwd, env: { ...process.env, ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });
