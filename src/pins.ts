import type { Env } from "./types";
import * as registry from "./registry";

export async function getPins(env: Env, person: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT pinned_boards FROM users WHERE name = ?").bind(person).first<{ pinned_boards: string | null }>();
  let ids: unknown;
  try { ids = JSON.parse(row?.pinned_boards ?? "[]"); } catch { ids = []; }
  if (!Array.isArray(ids)) return [];
  const member = new Set((await registry.boardsForUser(env, person)).filter(b => !b.archived_at).map(b => b.id));
  return ids.filter((id): id is string => typeof id === "string" && member.has(id)).slice(0, 5);
}

export async function putPins(env: Env, person: string, ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids) || ids.length > 5 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length)
    throw new Error("Send up to five distinct board IDs.");
  const member = new Set((await registry.boardsForUser(env, person)).filter(b => !b.archived_at).map(b => b.id));
  if (ids.some(id => !member.has(id))) throw new Error("Pins must be active boards you belong to.");
  await env.DB.prepare("UPDATE users SET pinned_boards = ? WHERE name = ?").bind(JSON.stringify(ids), person).run();
  return ids;
}

export function sortPinned<T extends { id: string }>(boards: T[], pins: string[]): T[] {
  const rank = new Map(pins.map((id, i) => [id, i]));
  return [...boards].sort((a, b) => (rank.get(a.id) ?? 5) - (rank.get(b.id) ?? 5));
}
