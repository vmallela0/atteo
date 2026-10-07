// A name a person gives their agent ("Jarvis"). It never stands alone: everywhere it shows, its owner shows too
// ("Jarvis · vedu's agent"), and it can't pass for a person or for someone else's agent. Pure: social.ts checks
// the names it must not look like against D1.

export const AGENT_NAME_MAX = 24;
/** Words that already mean something after "@" (group mentions), or that would read as someone else. */
export const RESERVED_AGENT_NAMES = ["agents", "humans", "all", "everyone", "you", "atteo"];
const SHAPE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _'-]*$/u;
const USER_SHAPE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

export class AgentNameError extends Error {}

// Latin look-alikes from Cyrillic, Greek and IPA (lowercase, after NFKC and dropping accents). Not all of Unicode's
// confusables, just the ones that pass for ASCII letters in a handle.
const LOOKALIKE: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ь: "b",
  ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", һ: "h", ӏ: "l", ԛ: "q", ԝ: "w", ү: "y", ɡ: "g", ɑ: "a", ɩ: "i", ı: "i",
  ȷ: "j", ł: "l", ø: "o", đ: "d", ʟ: "l", ʏ: "y",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", γ: "y", ω: "w",
};

/** What a name looks like: NFKC, lowercase, accents dropped, look-alike letters mapped to Latin, apostrophes straight. */
export function skeleton(s: string): string {
  const base = s.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  return [...base].map((ch) => LOOKALIKE[ch] ?? ch).join("").replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, " ").trim();
}

/** Handles a name could pass for: "j xn" might be read as jxn, j.xn, j_xn or j-xn. */
export function handleLookalikes(name: string): string[] {
  const sk = skeleton(name);
  const out = new Set([sk, sk.replace(/[\s_'-]+/g, ""), ...[".", "_", "-"].map((sep) => sk.replace(/[\s_'-]+/g, sep))]);
  return [...out].filter((h) => USER_SHAPE.test(h));
}

/**
 * The stored form of a requested name, or null to clear it ("" or null). Throws AgentNameError with a message a
 * person can act on. Doesn't know who's on Atteo: the caller also refuses names that look like a person's.
 */
export function cleanAgentName(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new AgentNameError("agent_name must be text, or null to clear it.");
  const name = raw.normalize("NFKC").replace(/[‘’ʼ`]/g, "'").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if ([...name].length > AGENT_NAME_MAX) throw new AgentNameError(`An agent's name is at most ${AGENT_NAME_MAX} characters.`);
  if (!SHAPE.test(name)) throw new AgentNameError("An agent's name uses letters, numbers, spaces, - _ and ' (starting with a letter or number).");
  const sk = skeleton(name);
  if (/'\s*s[\s_-]*agent/.test(sk)) throw new AgentNameError(`An agent's name can't say whose agent it is ("'s agent"): Atteo always shows its owner next to it.`);
  const bare = sk.replace(/[\s_'-]+/g, "");
  if (RESERVED_AGENT_NAMES.some((w) => sk === w || bare === w)) throw new AgentNameError(`"${name}" is reserved: ${RESERVED_AGENT_NAMES.map((w) => "@" + w).join(", ")} already mean something.`);
  if (/^(your|atteo)/.test(bare) || /agents?$/.test(bare)) throw new AgentNameError(`"${name}" reads as an agent or Atteo: choose a name that doesn't claim either identity.`);
  return name;
}
