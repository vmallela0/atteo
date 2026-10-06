// atteo host's shared rules (docs/HOST.md): the typed consent, the folder jail, secrets, output caps.
import { describe, expect, it } from "vitest";
import { cleanOutput, clampTimeout, codeSpan, commandProblem, consentScope, CWD_RE, HOST_PHRASE, insideShares, MAX_OUTPUT, normPath, phraseOk, RUN_ID_RE, SAFE_PATH, safeEnv, shareProblem, termSafe } from "../src/hostCore";
import { bwrapArgs, macProfile } from "../src/hostSandbox";
import { redactText } from "../src/secrets";
import { HOST_LOADER_JS, HOST_PAGE_JS } from "../src/hostUi";

describe("atteo host rules", () => {
  it("needs the exact phrase (a phone's curly apostrophe counts)", () => {
    expect(phraseOk(HOST_PHRASE)).toBe(true);
    expect(phraseOk("I understand what I’m doing")).toBe(true);
    for (const bad of ["i understand what i'm doing", "I understand what I'm doing.", " I understand what I'm doing", "yes", "", null, 1]) expect(phraseOk(bad)).toBe(false);
  });

  it("keeps a working folder inside the shares: no .. escape, no sibling prefix, never /", () => {
    const shares = ["/home/v/proj"];
    expect(insideShares("/home/v/proj", shares)).toBe(true);
    expect(insideShares("/home/v/proj/src/./lib", shares)).toBe(true);
    expect(insideShares("/home/v/proj/../.ssh", shares)).toBe(false);
    expect(insideShares("/home/v/proj/src/../../..", shares)).toBe(false);
    expect(insideShares("/home/v/project-other", shares)).toBe(false);
    expect(insideShares("relative/path", shares)).toBe(false);
    expect(insideShares("/etc", ["/"])).toBe(false);
    expect(normPath("/a/b/../c/")).toBe("/a/c");
    expect(normPath("a/b")).toBeNull();
  });

  it("refuses commands with credentials, NULs, or nothing in them", () => {
    expect(commandProblem("ls -la")).toBeNull();
    expect(commandProblem("")).toMatch(/Say what to run/);
    expect(commandProblem("echo a\0b")).toMatch(/NUL/);
    expect(commandProblem("curl -H 'Authorization: x' https://api.github.com -u me:ghp_" + "a".repeat(36))).toMatch(/GitHub token/);
    expect(commandProblem("x".repeat(5000))).toMatch(/over/);
  });

  it("redacts secrets from output and caps it", () => {
    const out = cleanOutput("ok\nAWS key AKIAABCDEFGHIJKLMNOP done\npassword=hunter2abc9\n");
    expect(out.text).toContain("[redacted: an AWS access key]");
    expect(out.text).toContain('[redacted: a value for "password"]');
    expect(out.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(out.text).not.toContain("hunter2abc9");
    const big = cleanOutput("x".repeat(MAX_OUTPUT + 10));
    expect(big.truncated).toBe(true);
    expect(big.text).toMatch(/10 more characters not kept/);
    expect(redactText("nothing secret here")).toBe("nothing secret here");
  });

  it("the web's /host.js and its loader are valid scripts", () => {
    expect(() => new Function(HOST_PAGE_JS)).not.toThrow();
    expect(() => new Function(HOST_LOADER_JS)).not.toThrow();
    expect(HOST_PAGE_JS).toContain(JSON.stringify(HOST_PHRASE));
  });

  it("clamps timeouts", () => {
    expect(clampTimeout(undefined)).toBe(60);
    expect(clampTimeout(5)).toBe(5);
    expect(clampTimeout(99999)).toBe(600);
  });

  // #4918: an allowlist, not a denylist.
  it("passes a command only a fixed PATH, the locale, TZ, a dumb terminal and a sandbox HOME", () => {
    const env = safeEnv({ PATH: "/evil:/usr/bin", HOME: "/Users/v", LANG: "en_US.UTF-8", LC_ALL: "C", TZ: "UTC", SSH_AUTH_SOCK: "/tmp/agent", DATABASE_URL: "postgres://u:p@h/db", STRIPE_KEY: "sk", KUBECONFIG: "/k", USER: "v", ATTEO_CREDENTIALS_FILE: "/c" }, "/tmp/box");
    expect(env).toEqual({ PATH: SAFE_PATH, TERM: "dumb", HOME: "/tmp/box", TMPDIR: "/tmp/box", LANG: "en_US.UTF-8", LC_ALL: "C", TZ: "UTC" });
  });

  // #4917: never /, system folders, hidden folders, homes, or anything containing the owner's home.
  it("refuses folders that hold keys, logins or the whole system", () => {
    const home = "/Users/v";
    for (const bad of ["/", "/Users", "/home", "/Users/v", "/home/v", "/Users/v/.ssh", "/Users/v/.config/agent-board", "/Users/v/code/.git", "/etc", "/usr/local/src", "/private/var/x", "/var/tmp/p", "/System/x", "/opt/homebrew", "relative", "/Users/v/a\x1b[2Jb"]) expect(shareProblem(bad, home), bad).not.toBeNull();
    for (const ok of ["/Users/v/code/proj", "/srv/proj", "/home/r/p", "/Volumes/Work/proj"]) expect(shareProblem(ok, home), ok).toBeNull();
    expect(shareProblem("/Users/v/code", "/Users/v/code/proj/home")).toMatch(/home folder/); // contains the home
    expect(shareProblem("/home", null)).toMatch(/home folder/); // the server, without a HOME
  });

  // #4929: what you see is what runs.
  it("refuses commands with bidi controls, invisible characters or control characters", () => {
    for (const bad of ["ls ‮ cod.exe", "rm -rf​ /", "echo ⁦x⁩", "a­b", "﻿ls", "printf '\x1b[2J'", "a\rb"]) expect(commandProblem(bad), JSON.stringify(bad)).toMatch(/invisible|control/);
    expect(commandProblem("echo 'tab\there'\nls")).toBeNull();
    expect(commandProblem("echo héllo")).toBeNull(); // non-ASCII letters run; the card shows them escaped
  });

  // #4919: nothing from the server reaches the owner's terminal as an escape sequence.
  it("shows control and invisible characters escaped before printing to the terminal", () => {
    expect(termSafe("ok\x1b[31mred\x07\n")).toBe("ok\\x1b[31mred\\x07\\x0a");
    expect(termSafe("a‮b")).toBe("a\\u{202e}b");
    expect(termSafe(null)).toBe("");
    expect(normPath("/srv/p\x1b]0;x\x07")).toBeNull();
  });

  // #4920: a run id goes into a URL only if it looks like one.
  it("checks run ids before they reach a URL", () => {
    expect(RUN_ID_RE.test("hr_abcDEF123_-x")).toBe(true);
    for (const bad of ["hr_../../x", "hr_a/b", "x", "hr_", "hr_abc?x=1"]) expect(RUN_ID_RE.test(bad)).toBe(false);
  });

  // #4917: a code covers the folders and commands the person saw, in that order.
  it("binds consent to the exact shares and allowlist", () => {
    expect(consentScope(["/srv/p/./a"], ["git status"])).toBe(consentScope(["/srv/p/a"], ["git status"]));
    expect(consentScope(["/srv/p"], [])).not.toBe(consentScope(["/srv/p", "/srv/q"], []));
    expect(consentScope(["/srv/p"], [])).not.toBe(consentScope(["/srv/p"], ["make"]));
    expect(consentScope(["/srv/p"], [], true)).not.toBe(consentScope(["/srv/p"], [])); // network is part of it (jxn #4945)
  });

  // #4916: the sandbox is the boundary.
  it("builds a macOS profile that forbids home, writes and the keychain, then opens only the shares and its temp", () => {
    const p = macProfile(["/Users/v/code/proj"], "/private/var/folders/xy/T/atteo-run-1", "/Users/v");
    expect(p).not.toMatch(/\(allow file-write\*\)|\(allow file-write\* \(subpath "\/"/); // writes only where listed
    expect(p).toContain('(deny file-read* (subpath "/Users/v")');
    expect(p).not.toMatch(/SecurityServer|securityd|secd|trustd/); // the keychain's services aren't on the Mach list
    expect(p).toContain('(allow file-read* file-write* (subpath "/Users/v/code/proj") (subpath "/private/var/folders/xy/T/atteo-run-1"))');
    expect(p).toContain('(literal "/Users/v/code")'); // ancestors: metadata only
    expect(p.lastIndexOf("allow file-read* file-write*")).toBeGreaterThan(p.indexOf("deny file-read*")); // later rules win
    expect(macProfile(['/a"b'], "/t", "/h")).toContain('"/a\\"b"'); // a quote can't end the string
  });

  // alt-c #4916a, jxn #4945: nothing is allowed unless listed; no network or Apple Events by default.
  it("denies by default: Mach services only from a short list, network only with --allow-network", () => {
    const p = macProfile(["/Users/v/code/proj"], "/t", "/Users/v");
    expect(p.split("\n")[1]).toBe("(deny default)");
    expect(p).not.toContain("(allow default)");
    expect(p).not.toMatch(/network|appleevent|com\.apple\.(pasteboard|coreservices|lsd|xpc\.launchd)|dnssd/);
    expect(p).toMatch(/\(allow mach-lookup \(global-name "com\.apple\.system\.opendirectoryd\.libinfo"\)/);
    const net = macProfile(["/Users/v/code/proj"], "/t", "/Users/v", true);
    expect(net).toContain("(allow network-outbound network-inbound network-bind system-socket)");
    expect(net).toContain('(global-name "com.apple.dnssd.service")');
    expect(net).not.toMatch(/appleevent|pasteboard/);
  });

  // alt-c #4916b: what runs later outside the sandbox stays read-only inside it.
  it("keeps .git (itself, hooks, config) and .envrc read-only, last, so nothing reopens them", () => {
    const p = macProfile(["/Users/v/my.proj"], "/t", "/Users/v");
    const last = p.split("\n").at(-1)!;
    expect(last.startsWith("(deny file-write* ")).toBe(true);
    const res = [...last.matchAll(/regex #"([^"]+)"/g)].map((m) => new RegExp(m[1]));
    const hit = (f: string) => res.some((r) => r.test(f));
    for (const f of ["/Users/v/my.proj/.git", "/Users/v/my.proj/.git/config", "/Users/v/my.proj/.git/config.worktree", "/Users/v/my.proj/.git/hooks", "/Users/v/my.proj/.git/hooks/pre-commit", "/Users/v/my.proj/sub/.git/hooks/x", "/Users/v/my.proj/.git/modules/m/config", "/Users/v/my.proj/.envrc", "/Users/v/my.proj/a/.envrc"]) expect(hit(f), f).toBe(true);
    for (const f of ["/Users/v/my.proj/.git/objects/ab/cd", "/Users/v/my.proj/.git/index", "/Users/v/my.proj/.git/refs/heads/main", "/Users/v/my.proj/src/config", "/Users/v/myXproj/.git/config", "/Users/v/my.proj/.gitignore"]) expect(hit(f), f).toBe(false);
  });

  it("builds bubblewrap arguments: system read-only, shares read-write, a private /tmp, no shared session", () => {
    const a = bwrapArgs(["/home/v/proj"], "/home/v/proj/src", "make test");
    expect(a).toEqual(expect.arrayContaining(["--die-with-parent", "--new-session", "--unshare-pid", "--tmpfs", "/tmp"]));
    expect(a.join(" ")).toContain("--bind /home/v/proj /home/v/proj");
    expect(a.join(" ")).toContain("--ro-bind-try /usr /usr");
    expect(a.join(" ")).not.toContain("--bind /home/v /home/v");
    expect(a.slice(-3)).toEqual(["/bin/sh", "-c", "make test"]);
    expect(a).toContain("--unshare-net"); // no network, localhost or abstract sockets by default (jxn #4945)
    expect(bwrapArgs(["/home/v/proj"], "/home/v/proj", "ls", { network: true })).not.toContain("--unshare-net");
    const g = bwrapArgs(["/home/v/proj"], "/home/v/proj", "ls", { gitDirs: ["/home/v/proj/.git"], envrcs: ["/home/v/proj/.envrc"] }).join(" ");
    expect(g).toContain("--bind /home/v/proj/.git /home/v/proj/.git --ro-bind-try /home/v/proj/.git/hooks /home/v/proj/.git/hooks --ro-bind-try /home/v/proj/.git/config /home/v/proj/.git/config");
    expect(g).toContain("--ro-bind /home/v/proj/.envrc /home/v/proj/.envrc");
    expect(g.indexOf("--bind /home/v/proj /home/v/proj")).toBeLessThan(g.indexOf("/.git/hooks")); // on top of the share
  });

  // alt-c #4917: /tmp is everyone's.
  it("refuses temp folders as shares on every OS", () => {
    for (const bad of ["/tmp", "/tmp/proj", "/private/tmp/p", "/var/tmp/p"]) expect(shareProblem(bad, "/home/v"), bad).not.toBeNull();
  });

  // #5003: a requester's folder is plain path text, shown as code.
  it("takes only plain path characters in a cwd, and code-spans what it shows", () => {
    for (const ok of ["/srv/proj", "/srv/proj/sub dir", "/srv/a-b_c.d"]) expect(CWD_RE.test(ok), ok).toBe(true);
    for (const bad of ["/srv/proj/ · asked by o's own agent: ok", "/srv/[x](http://e)", "/srv/`x`", "/srv/é", "/srv/a\nb", ""]) expect(CWD_RE.test(bad), bad).toBe(false);
    expect(codeSpan("/srv/a`b")).toBe("`/srv/aʼb`");
  });

});
