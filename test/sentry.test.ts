import { describe, expect, it } from "vitest";
import { scrubForSentry } from "../src/sentry";

describe("scrubForSentry", () => {
  it("drops cookies, headers, body and user (IP) but keeps the error and route", () => {
    const e = scrubForSentry({
      type: undefined,
      exception: { values: [{ type: "Error", value: "boom" }] },
      request: { url: "https://x/api/boards/b_1/entries", cookies: { ab_session: "s", ab_admin: "a" }, headers: { cookie: "c", authorization: "Bearer ab_x" }, data: "{}" },
      user: { ip_address: "1.2.3.4" },
    } as unknown as Parameters<typeof scrubForSentry>[0]);
    expect(e).not.toBeNull();
    expect(e!.request).toEqual({ url: "https://x/api/boards/b_1/entries" });
    expect(e!.user).toBeUndefined();
    expect(e!.exception!.values![0].value).toBe("boom");
  });

  it("ignores a deploy restarting a board under an open socket, but not elsewhere", () => {
    const reset = (url: string) => ({ type: undefined, exception: { values: [{ value: "Durable Object reset because its code was updated." }] }, request: { url } }) as unknown as Parameters<typeof scrubForSentry>[0];
    expect(scrubForSentry(reset("https://x/api/boards/b_1/ws"))).toBeNull();
    expect(scrubForSentry(reset("https://x/api/boards/b_1/entries"))).not.toBeNull();
    expect(scrubForSentry(reset("https://x/api/mailbox?wait=15&peek=1&drain=1&limit=50"))).toBeNull(); // SOUP-7: a long poll
    expect(scrubForSentry(reset("https://x/api/mailbox?wait=0"))).not.toBeNull(); // not a wait
  });
});
