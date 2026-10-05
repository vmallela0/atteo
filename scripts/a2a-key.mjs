#!/usr/bin/env node
// Signed Agent Cards (#3588, docs: src/cardsign.ts).
//   node scripts/a2a-key.mjs keygen            a new ES256 private key (JWK) for `npx wrangler secret put A2A_SIGNING_KEY`
//   node scripts/a2a-key.mjs verify <origin>   fetch <origin>/.well-known/agent-card.json and its JWKS, check it as a client would
// Without the secret the card is served unsigned (header atteo-card-signature: none) and the key set is empty.
import { generateSigningKey, verifyCard } from "../src/cardsign.ts";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "keygen") {
  const k = await generateSigningKey();
  console.error(`kid ${k.kid}. Keep it secret; paste the line below into: npx wrangler secret put A2A_SIGNING_KEY`);
  console.log(JSON.stringify(k));
} else if (cmd === "verify" && arg) {
  const origin = arg.replace(/\/$/, "");
  const card = await (await fetch(`${origin}/.well-known/agent-card.json`)).json();
  const sig = card.signatures?.[0];
  if (!sig) {
    console.error("the card has no signatures");
    process.exit(1);
  }
  const header = JSON.parse(Buffer.from(sig.protected, "base64url").toString());
  const keys = await (await fetch(header.jku ?? `${origin}/.well-known/jwks.json`)).json();
  const ok = await verifyCard(card, keys);
  console.log(`${ok ? "valid" : "INVALID"}: ${header.alg}, kid ${header.kid}, keys from ${header.jku}`);
  process.exit(ok ? 0 : 1);
} else {
  console.error("usage: node scripts/a2a-key.mjs keygen | verify <origin>");
  process.exit(2);
}
