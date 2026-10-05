import { describe, expect, it } from "vitest";
import { agentCard, signedCard } from "../src/a2a";
import { cardPayload, generateSigningKey, jcs, jwks, signCard, thumbprint, verifyCard } from "../src/cardsign";
import type { Env } from "../src/types";

const nodeCrypto = (await import("node:" + "crypto")) as unknown as {
  createPublicKey: (o: { key: JsonWebKey; format: "jwk" }) => unknown;
  verify: (alg: string, data: Uint8Array, o: { key: unknown; dsaEncoding: string }, sig: Uint8Array) => boolean;
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const env = (key?: string) => ({ A2A_SIGNING_KEY: key }) as unknown as Env;
const O = "https://atteo.dev";
const SDK_PAYLOAD = "{\"capabilities\":{\"pushNotifications\":false,\"streaming\":false},\"defaultInputModes\":[\"text/plain\"],\"defaultOutputModes\":[\"text/plain\"],\"description\":\"Ask the agents on an Atteo board (agents owned by different people) and get their answers. Messages go to a board as questions addressed to one member's agent.\",\"documentationUrl\":\"https://atteo.dev/openapi.json\",\"name\":\"Atteo\",\"provider\":{\"organization\":\"Atteo\",\"url\":\"https://atteo.dev\"},\"securitySchemes\":{\"token\":{\"description\":\"A personal token from Account, Agent connections (or MCP sign-in).\",\"scheme\":\"bearer\"}},\"skills\":[{\"description\":\"Posts your message as a question to one member's agent on a board you belong to; the task completes with their answer. Put {\\\"board\\\": \\\"<board id or name>\\\", \\\"to\\\": \\\"<member>\\\"} in message.metadata.\",\"examples\":[\"{\\\"metadata\\\": {\\\"board\\\": \\\"checkout\\\", \\\"to\\\": \\\"theo\\\"}, \\\"parts\\\": [{\\\"kind\\\": \\\"text\\\", \\\"text\\\": \\\"Which port does staging use?\\\"}]}\"],\"id\":\"ask\",\"name\":\"Ask a member's agent\",\"tags\":[\"collaboration\",\"agents\",\"questions\"]}],\"url\":\"https://atteo.dev/a2a\",\"version\":\"1\"}";

describe("JCS (RFC 8785)", () => {
  it("matches the A2A spec's example (§8.4.1)", () => {
    expect(jcs({ name: "Example Agent", description: "", capabilities: { streaming: false, pushNotifications: false }, skills: [] })).toBe(
      `{"capabilities":{"pushNotifications":false,"streaming":false},"description":"","name":"Example Agent","skills":[]}`,
    );
  });
  it("sorts keys by UTF-16 code units and writes numbers and strings as ECMAScript does (RFC 8785 §3.2.3, appendix B)", () => {
    // RFC 8785 §3.2.3's sorting example: "€" (euro), "\r", "דּ" (Hebrew), "1", "😀" (emoji), "\u0080", "ö"
    const o = { "€": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    const order = [...jcs(o).matchAll(/:"([^"]+)"/g)].map((m) => m[1]); // JSON.parse would put "1" first
    expect(order).toEqual(["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"]);
    expect(jcs([1e21, 0.1, -0, 333333333.33333329, 1e-7, "  é \u0001"])).toBe(`[1e+21,0.1,0,333333333.3333333,1e-7,"  é \\u0001"]`);
    expect(jcs({ b: [{ z: 1, a: undefined }], a: null })).toBe(`{"a":null,"b":[{"z":1}]}`);
    expect(() => jcs({ n: NaN })).toThrow();
  });
});

describe("signed Agent Cards (A2A §8.4, #3588)", () => {
  it("signs the card's JCS form with ES256; the JWS checks out with Node's own crypto", async () => {
    const key = await generateSigningKey();
    const card = await signCard(agentCard(O), key, `${O}/.well-known/jwks.json`);
    expect(card.signatures).toHaveLength(1);
    const { protected: p, signature } = card.signatures[0];
    expect(JSON.parse(new TextDecoder().decode(fromB64url(p)))).toEqual({ alg: "ES256", typ: "JOSE", kid: key.kid, jku: `${O}/.well-known/jwks.json` });
    // A verifier that shares no code with ours: the JWS signing input over the canonical payload, r‖s signature.
    const input = new TextEncoder().encode(`${p}.${Buffer.from(cardPayload(card)).toString("base64url")}`);
    const pub = nodeCrypto.createPublicKey({ key: (await jwks(env(JSON.stringify(key)))).keys[0], format: "jwk" });
    expect(nodeCrypto.verify("sha256", input, { key: pub, dsaEncoding: "ieee-p1363" }, fromB64url(signature))).toBe(true);
    expect(cardPayload(card)).toBe(cardPayload(agentCard(O))); // signatures aren't part of it
  });

  it("a client accepts it, and refuses it once anything is changed or the key is someone else's", async () => {
    const key = await generateSigningKey();
    const keys = await jwks(env(JSON.stringify(key)));
    const card = await signCard(agentCard(O), key, `${O}/.well-known/jwks.json`);
    expect(await verifyCard(card, keys)).toBe(true);
    expect(await verifyCard(JSON.parse(JSON.stringify(card)), keys)).toBe(true); // survives the trip over the wire
    expect(await verifyCard({ ...card, url: "https://evil.example/a2a" }, keys)).toBe(false);
    expect(await verifyCard({ ...card, skills: [] }, keys)).toBe(false);
    const other = await generateSigningKey();
    expect(await verifyCard(card, await jwks(env(JSON.stringify(other))))).toBe(false);
    expect(await verifyCard(await signCard(agentCard(O), other, "x"), keys)).toBe(false);
    expect(await verifyCard(agentCard(O), keys)).toBe(false); // unsigned
  });

  it("signs what a2a-sdk 0.3's verifier rebuilds from the card, byte for byte", () => {
    // canonicalize_agent_card(AgentCard.model_validate(agentCard("https://atteo.dev"))) from a2a-sdk 0.3.26: defaults
    // (protocolVersion, preferredTransport, a scheme's type) and empty values dropped, keys sorted. Change the card and
    // this string goes with it; check the new one with the SDK (see the handoff of #3588).
    expect(cardPayload(agentCard(O))).toBe(SDK_PAYLOAD);
    expect(/^[\x20-\x7e]*$/.test(JSON.stringify(agentCard(O)))).toBe(true); // ASCII: the SDK escapes anything else
    expect(cardPayload({ ...agentCard(O), protocolVersion: "0.4.0" })).toContain(`"protocolVersion":"0.4.0"`); // only defaults go
  });

  it("is signed only with the A2A_SIGNING_KEY secret: unset or malformed, the card is unsigned and the key set empty", async () => {
    const key = await generateSigningKey();
    const signed = await signedCard(env(JSON.stringify(key)), O);
    expect(await verifyCard(signed, await jwks(env(JSON.stringify(key))))).toBe(true);
    expect(await signedCard(env(JSON.stringify(key)), O)).toBe(signed); // cached per origin and key
    const err = console.error;
    console.error = () => {};
    try {
      for (const bad of [undefined, "", "not json", JSON.stringify({ ...key, d: undefined }), JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "a", d: "b" })]) {
        expect((await signedCard(env(bad), O)).signatures).toBeUndefined();
        expect(await jwks(env(bad))).toEqual({ keys: [] });
      }
    } finally {
      console.error = err;
    }
  });

  it("publishes only the public half, under its RFC 7638 thumbprint", async () => {
    const key = await generateSigningKey();
    const [pub] = (await jwks(env(JSON.stringify(key)))).keys;
    expect(pub).toEqual({ kty: "EC", crv: "P-256", x: key.x, y: key.y, kid: key.kid, use: "sig", alg: "ES256" });
    expect(JSON.stringify(pub)).not.toContain(key.d!);
    expect(await thumbprint(pub)).toBe(key.kid);
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
