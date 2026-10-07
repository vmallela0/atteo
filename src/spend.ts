/** Public API short-context list prices per million tokens, checked 2026-10-06. Estimates ignore cache, batch and tier discounts.
 * Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * OpenAI: https://developers.openai.com/api/docs/pricing
 * Google: https://ai.google.dev/gemini-api/docs/pricing */
export const PRICE_DATE = "2026-10-06";
export const PRICES: Record<string, readonly [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-4-5": [5, 25],
  "claude-sonnet-4-5": [3, 15],
  "claude-haiku-4-5": [1, 5],
  "gpt-5.2": [1.75, 14],
  "gpt-6-astra": [5, 25],
  "gpt-6.1-sol": [1, 5],
  "gpt-6-luna": [0.05, 0.25],
  "gpt-5": [1.25, 10],
  "gpt-5-mini": [0.25, 2],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-3.1-pro-preview": [2, 12],
  "gemini-3.1-pro-preview-customtools": [2, 12],
  "gemini-3.1-flash-lite": [0.25, 1.5],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-flash-lite": [0.1, 0.4],
};

export interface Usage { model: string; input_tokens: number; output_tokens: number; cost_usd?: number }
export type PricedUsage = Omit<Usage, "cost_usd"> & { cost_usd: number | null; estimate: boolean };

export function priceUsage(raw: unknown): PricedUsage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("usage must be an object.");
  const u = raw as Record<string, unknown>;
  const model = typeof u.model === "string" ? u.model.trim() : "";
  if (!model || model.length > 100 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error("usage.model must be 1–100 printable characters.");
  for (const key of ["input_tokens", "output_tokens"] as const)
    if (!Number.isSafeInteger(u[key]) || (u[key] as number) < 0 || (u[key] as number) > 100_000_000) throw new Error(`usage.${key} must be a whole number from 0 to 100,000,000.`);
  if (u.cost_usd !== undefined && (typeof u.cost_usd !== "number" || !Number.isFinite(u.cost_usd) || u.cost_usd < 0 || u.cost_usd > 100_000)) throw new Error("usage.cost_usd must be from 0 to 100,000.");
  const input_tokens = u.input_tokens as number, output_tokens = u.output_tokens as number;
  const given = u.cost_usd as number | undefined;
  const rates = PRICES[model.toLowerCase().replace(/-\d{8}$/, "")];
  return { model, input_tokens, output_tokens, cost_usd: given ?? (rates ? (input_tokens * rates[0] + output_tokens * rates[1]) / 1_000_000 : null), estimate: given === undefined };
}
