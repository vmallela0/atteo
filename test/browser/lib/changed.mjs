// For run.mjs --changed: which browser checks a list of changed files needs (rules from checks-map.json).
/** "*" (every check) if any file has no narrowing rule, else a Set of check names. test/browser/<check>.mjs always
 *  picks that check; a rule's globs use * (one path segment) and ** (any depth); the first matching rule wins. */
export function checksFor(files, rules, checks) {
  const known = new Set(checks);
  const re = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
  const compiled = Object.entries(rules).map(([g, v]) => [re(g), v]);
  const out = new Set();
  for (const f of files) {
    const own = f.match(/^test\/browser\/([^/]+)\.mjs$/);
    if (own && known.has(own[1])) { out.add(own[1]); continue; }
    const hit = compiled.find(([r]) => r.test(f));
    if (!hit || hit[1] === "*") return "*";
    for (const t of hit[1]) if (known.has(t)) out.add(t);
  }
  return out;
}
