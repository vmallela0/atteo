// The CLI's side of the device sign-in (src/device.ts): ask for a code, show it, poll until the person approves it in
// the browser where they're signed in. Nothing to paste back into the terminal.

/** The saved login (credentials.ts Credentials; not imported, so this file stays free of node: modules for tests). */
type Credentials = { server: string; user: string; token: string; expires_at: number };

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function startLogin(server: string, client: string, userAgent: string, f: Fetch = fetch): Promise<DeviceStart> {
  const res = await f(`${server}/api/device/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ client }),
  });
  if (!res.ok) throw new Error(res.status === 429 ? "Too many sign-ins from here just now. Wait a minute, then try again." : `Couldn't start sign-in (${res.status}).`);
  return (await res.json()) as DeviceStart;
}

/** Polls at the server's interval until the code is approved (then saves the login), denied or expired. */
export async function waitForApproval(
  server: string,
  d: DeviceStart,
  save: (c: Credentials) => void,
  f: Fetch = fetch,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
): Promise<Credentials> {
  const deadline = now() + d.expires_in * 1000;
  while (now() < deadline) {
    await sleep(d.interval * 1000);
    const res = await f(`${server}/api/device/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: d.device_code }) });
    const j = (await res.json().catch(() => ({}))) as { status?: string; token?: string; user?: string; expires_at?: number };
    if (j.status === "ok" && j.token && j.user && j.expires_at) {
      const c = { server, user: j.user, token: j.token, expires_at: j.expires_at };
      save(c);
      return c;
    }
    if (j.status === "denied") throw new Error("Sign-in was denied in the browser.");
    if (j.status === "expired" || j.status === "used") break;
  }
  throw new Error("That sign-in code expired. Run the command again for a new one.");
}
