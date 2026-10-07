// Board approval rules are metadata: names, modes and dollar thresholds are visible to the server, including on E2E boards.
import type { Env } from "./types";

export const CATEGORIES = ["deploy_production", "outbound_external", "spending", "delete_data", "push_main", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Mode = "ask" | "auto" | "block";
export const LABELS: Record<Category, string> = {
  deploy_production: "Deploy to production", outbound_external: "Message or email outside the board", spending: "Spend money", delete_data: "Delete data", push_main: "Push to main", other: "Other",
};
export interface Rule { category: Category; name: string; mode: Mode; threshold: number | null; set_by: string | null; updated_at: number | null }
const categoryOf = (v: unknown): Category => {
  if (typeof v !== "string" || !CATEGORIES.includes(v as Category)) throw new Error(`category is one of: ${CATEGORIES.join(", ")}`);
  return v as Category;
};
export function amountOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1_000_000_000 || Math.abs(Math.round(v * 100) - v * 100) > 0.000001) throw new Error("amount must be a positive dollar amount with at most two decimal places.");
  return v;
}
export function parseRule(category: unknown, body: unknown): { category: Category; mode: Mode; threshold: number | null } {
  const c = categoryOf(category);
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof b.mode !== "string" || !["ask", "auto", "block"].includes(b.mode)) throw new Error("mode is ask, auto or block.");
  if (c !== "spending" && b.threshold != null) throw new Error("Only spending has a threshold.");
  const threshold = c === "spending" ? (b.threshold == null || b.threshold === 0 ? 0 : amountOf(b.threshold)) : null;
  return { category: c, mode: b.mode as Mode, threshold };
}
export async function list(env: Env, board: string): Promise<Rule[]> {
  const rows = (await env.DB.prepare("SELECT category, mode, threshold, set_by, updated_at FROM approval_rules WHERE board_id = ?").bind(board).all<Rule>()).results;
  return CATEGORIES.map(category => { const r = rows.find(x => x.category === category); return { category, name: LABELS[category], mode: r?.mode ?? "ask", threshold: category === "spending" ? r?.threshold ?? 0 : null, set_by: r?.set_by ?? null, updated_at: r?.updated_at ?? null }; });
}
export async function check(env: Env, board: string, category: unknown, amount?: unknown): Promise<{ rule: Rule; outcome: Mode; reason: string }> {
  const c = categoryOf(category);
  const dollars = c === "spending" ? amountOf(amount) : null;
  if (c !== "spending" && amount != null) throw new Error("amount goes only with spending.");
  const rule = (await list(env, board)).find(x => x.category === c)!;
  const below = c === "spending" && dollars! <= (rule.threshold ?? 0) && rule.threshold! > 0;
  const outcome = below ? "auto" : rule.mode;
  const reason = below ? `${rule.name} up to $${rule.threshold!.toFixed(2)}` : rule.name;
  return { rule, outcome, reason };
}
export async function save(env: Env, board: string, category: unknown, body: unknown, by: string): Promise<Rule> {
  const r = parseRule(category, body);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO approval_rules (board_id, category, mode, threshold, set_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (board_id, category) DO UPDATE SET mode = excluded.mode, threshold = excluded.threshold, set_by = excluded.set_by, updated_at = excluded.updated_at")
    .bind(board, r.category, r.mode, r.threshold, by, now).run();
  return { ...r, name: LABELS[r.category], set_by: by, updated_at: now };
}
