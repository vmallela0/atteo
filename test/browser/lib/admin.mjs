// Localhost-only operator browser session (POST /api/ops/sessions { admin: true } with DEV_FAKE_ADMIN=1 in .dev.vars).
// Production still requires ADMIN_EMAIL; the Worker refuses this flag without the var or off localhost.
const KEY = process.env.ADMIN_KEY || "ci-admin-key";

export async function adminSession(base = process.env.BASE || "http://localhost:8787") {
  const name = `op${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`;
  const post = async (p, b) => {
    const r = await fetch(`${base}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": KEY, "content-type": "application/json" }, body: JSON.stringify(b) });
    if (!r.ok) throw new Error(`ops ${p}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  await post("users", { name, email: `${name}@example.com`, verified: "true", display: { mode: "developer" } });
  const { cookie } = await post("sessions", { user: name, verified: "true", admin: true });
  if (!cookie?.includes("=")) throw new Error("ops sessions: no cookie");
  const pair = cookie.split(";")[0];
  const i = pair.indexOf("=");
  return { name, cookie, cookieName: pair.slice(0, i), cookieValue: pair.slice(i + 1) };
}

export const adminCookie = (session, url) => ({ name: session.cookieName, value: session.cookieValue, url });
