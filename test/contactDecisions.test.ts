import { describe, expect, it } from "vitest";
import { contactDecisionError, PERSON_ONLY_CONTACT_DECISION } from "../src/social";
import { openapi } from "../src/openapi";

const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
const INDEX = readFileSync(new URL("../src/index.ts", (import.meta as unknown as { url: string }).url), "utf8");

function routeSlice(start: string, end: string): string {
  const from = INDEX.indexOf(start);
  const to = INDEX.indexOf(end, from);
  expect(from, `route start: ${start}`).toBeGreaterThan(-1);
  expect(to, `route end: ${end}`).toBeGreaterThan(from);
  return INDEX.slice(from, to);
}

describe("person-only contact decisions", () => {
  it("refuses agent tokens with a clear error and permits person identities", () => {
    expect(contactDecisionError("agent")).toBe(PERSON_ONLY_CONTACT_DECISION);
    expect(PERSON_ONLY_CONTACT_DECISION).toMatch(/Only you .*contact/i);
    expect(PERSON_ONLY_CONTACT_DECISION).toMatch(/agent tokens can't/i);
    expect(contactDecisionError("person")).toBeNull();
    expect(contactDecisionError(undefined)).toBeNull(); // browser sessions omit `via`
  });

  it("guards agent-DM accept and decline before changing the request", () => {
    const route = routeSlice('const cm = path.match(/^\\/api\\/contacts\\/', 'return json({ error: "not found" }, 404);');
    expect(route.indexOf("social.contactDecisionError(viewer.via)")).toBeGreaterThan(-1);
    expect(route.indexOf("social.contactDecisionError(viewer.via)")).toBeLessThan(route.indexOf("dm.decide("));
  });

  it("guards friendship relationship actions before changing the relationship", () => {
    const route = routeSlice('pm = path.match(/^\\/api\\/friends\\/', 'pm = path.match(/^\\/api\\/direct\\/');
    const guard = route.indexOf("social.contactDecisionError(viewer.via)");
    expect(guard).toBeGreaterThan(-1);
    for (const mutation of ["social.acceptFriend(", "social.blockPerson(", "social.removeFriend("]) {
      expect(guard).toBeLessThan(route.indexOf(mutation));
    }
  });

  it("documents both decision endpoints as person-authenticated", () => {
    const paths = openapi("https://example.test").paths;
    for (const path of ["/api/contacts/{user}/{decision}", "/api/friends/{user}/{action}"]) {
      expect(paths[path].post.security).toEqual([{ session: [] }, { appToken: [] }]);
      expect(paths[path].post.responses["403"]).toBeDefined();
    }
  });
});
