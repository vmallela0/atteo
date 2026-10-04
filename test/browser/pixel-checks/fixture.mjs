// Builds a busy board on the local Worker: two people, their agents, a thread, tasks, files, a change card.
export const BASE = process.env.BASE || "http://localhost:8787";
export const CHROME = process.env.PW_CHROME || undefined;
export const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
export async function fixture() {
  const run = Date.now().toString(36).slice(-4), A = `maya${run}`, B = `theo${run}`, C = `priya${run}`;
  for (const u of [A, B, C]) await ops("users", { name: u, email: `${u}@example.com`, verified: "true" });
  await ops("friends", { a: A, b: B }).catch(() => {});
  const tokB = (await ops("tokens", { user: B })).token, tokA = (await ops("tokens", { user: A })).token;
  const board = (await ops("boards", { user: A, title: "Checkout payments rewrite" })).board.id;
  await ops("members", { board, user: B }); await ops("members", { board, user: C });
  const ckA = (await ops("sessions", { user: A })).cookie;
  const mcp = (tok) => async (name, args) => { const r = await (await fetch(`${BASE}/mcp?board=${board}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json(); return r.result?.content?.[0]?.text ?? JSON.stringify(r); };
  const mb = mcp(tokB), ma = mcp(tokA);
  const web = async (path, body) => (await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: ckA }, body: JSON.stringify(body) })).json().catch(() => ({}));
  const num = (t) => +((t.match(/#(\d+)/) || [])[1] || 0);
  await web(`/api/boards/${board}/entries`, { type: "note", text: `Kicking off the checkout rewrite. @${B}'s agent can you map the current charge flow?` });
  await mb("read", {}); const root = num(await mb("post", { type: "note", text: "Mapped it: `charge()` runs before the cart is validated, so empty carts reach Stripe with an undefined amount. Three call sites need the guard.", reply_to: 0 }));
  await web(`/api/boards/${board}/entries`, { type: "question", text: "Which call sites? Paste the paths.", reply_to: root });
  await mb("read", {}); await mb("post", { type: "note", text: "src/checkout/charge.ts, src/api/pay.ts and src/jobs/retry-payments.ts", reply_to: root });
  await ma("read", {}); await ma("post", { type: "task", title: "Guard empty carts", text: "- [x] Find call sites\n- [ ] Add guard in charge()\n- [ ] Test with an empty cart", reply_to: 0 });
  await mb("read", {}); await mb("post", { type: "decision", text: "Ship the guard behind PAYMENTS_V2, flip it after a day in staging.", reply_to: 0 });
  await mb("read", {}); await mb("post", { type: "change", title: "Empty-cart guard on main", text: "On main, needs a ship.", reply_to: 0, card: { branch: "main", base: "abc1234", commits: [{ sha: "abc1234", title: "Guard empty carts in charge()" }, { sha: "def5678", title: "Test: empty cart returns 400" }], files: [{ path: "src/checkout/charge.ts", added: 12, removed: 3 }, { path: "test/checkout/empty-cart-really-long-name.test.ts", added: 40, removed: 0 }] } });
  await web(`/api/boards/${board}/entries`, { type: "note", text: `A long unbroken string to test wrapping: https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/spaces/at/all?x=1 and @${C}` });
  await mb("read", {}); await mb("post", { type: "question", text: `@${A} can you approve the hotfix before the demo? It touches the charge path.`, reply_to: 0 });
  await web(`/api/boards/${board}/doc`, { action: "write", name: "PLAN.md", content: "# Plan\n\n- Guard\n- Tests\n- Ship", base_version: 0, summary: "created" });
  await web(`/api/boards/${board}/doc`, { action: "write", name: "notes/a-rather-long-file-name-for-the-checkout-rewrite.md", content: "Notes", base_version: 0, summary: "created" });
  return { run, A, B, C, board, root, ckA };
}
export async function ctxFor(browser, cookie, w, scheme, h = 760) {
  const phone = w < 500;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone, deviceScaleFactor: 2, colorScheme: scheme });
  const [k, ...v] = cookie.split(";")[0].split("="); await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
  return ctx;
}
// Things that look off: sideways overflow, small tap targets, elements past the right edge.
export const audit = () => {
  const W = innerWidth, out = { doc: document.documentElement.scrollWidth, W, wide: [], small: [] };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.closest("[hidden],dialog:not([open])") ; };
  const name = (el) => (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "")) + " '" + (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 24).replace(/\n/g, " ") + "'";
  for (const el of document.querySelectorAll("body *")) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect();
    if (r.right > W + 1 && !el.closest(".thread-scroll,.tabs,.hscroll,pre,.table-wrap,[style*='overflow']")) out.wide.push(name(el) + ` r=${Math.round(r.right)}`);
  }
  for (const el of document.querySelectorAll("a[href],button,[role=tab],summary,input[type=checkbox],select,label[for]")) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect();
    if ((r.height < 36 || r.width < 32) && !el.closest("p,li .body,.body")) out.small.push(name(el) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  out.wide = [...new Set(out.wide)].slice(0, 25); out.small = [...new Set(out.small)].slice(0, 40);
  return out;
};
