// A board's charter: its goal, the data classes it may hold, how long messages stay, and a note for each member
// (what they do here). Membership itself stays in the members table; the note is the charter's metadata for them.

export const GOAL_MAX = 500;
export const DATA_CLASSES_MAX = 12;
export const DATA_CLASS_LEN = 32;
export const MEMBER_NOTE_MAX = 120;
export const RETENTION_MAX_DAYS = 3650;

export type CharterRole = "owner" | "contributor" | "viewer";

export interface CharterMember {
  user: string;
  role: CharterRole;
  note: string | null;
}

/** What members and the web see. */
export interface BoardCharter {
  goal: string | null;
  data_classes: string[];
  retention_days: number | null;
  members: CharterMember[];
}

/** What is stored on the board row. Notes are only for people still on the board. */
export interface StoredCharter {
  goal: string | null;
  data_classes: string[];
  retention_days: number | null;
  notes: Record<string, string>;
}

/** Fields a write actually sent. Omitted fields stay as they are. */
export interface CharterPatch {
  goal?: string | null;
  data_classes?: string[];
  retention_days?: number | null;
  notes?: Record<string, string | null>;
}

const USER_RE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

export function emptyStored(): StoredCharter {
  return { goal: null, data_classes: [], retention_days: null, notes: {} };
}

function jsonArray(s: string | null | undefined): string[] {
  try {
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  } catch {
    return [];
  }
}

function jsonNotes(s: string | null | undefined): Record<string, string> {
  try {
    const v = s ? JSON.parse(s) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "string" && val) out[k] = val;
    return out;
  } catch {
    return {};
  }
}

/** Reads the charter columns off a board row. Missing columns are an empty charter. */
export function storedFromRow(
  row: { goal?: string | null; data_classes?: string | null; retention_days?: number | null; member_notes?: string | null } | null | undefined,
): StoredCharter {
  if (!row) return emptyStored();
  const days = row.retention_days;
  return {
    goal: row.goal?.trim() ? row.goal : null,
    data_classes: jsonArray(row.data_classes),
    retention_days: typeof days === "number" && days > 0 ? days : null,
    notes: jsonNotes(row.member_notes),
  };
}

/** Columns for `UPDATE boards SET goal, data_classes, retention_days, member_notes`. Empty lists are stored as NULL. */
export function charterBinds(s: StoredCharter): { goal: string | null; data_classes: string | null; retention_days: number | null; member_notes: string | null } {
  const notes = Object.fromEntries(Object.entries(s.notes).filter(([, n]) => n).sort(([a], [b]) => a.localeCompare(b)));
  return {
    goal: s.goal,
    data_classes: s.data_classes.length ? JSON.stringify(s.data_classes) : null,
    retention_days: s.retention_days,
    member_notes: Object.keys(notes).length ? JSON.stringify(notes) : null,
  };
}

export function charterView(stored: StoredCharter, members: { user: string; role: CharterRole }[]): BoardCharter {
  const notes = stored.notes;
  return {
    goal: stored.goal,
    data_classes: stored.data_classes,
    retention_days: stored.retention_days,
    members: members.map((m) => ({ user: m.user, role: m.role, note: notes[m.user] ?? null })),
  };
}

/** One line for the audit log. */
export function charterAuditDetail(s: StoredCharter): string {
  const n = Object.keys(s.notes).length;
  return [
    s.goal ? "goal set" : "no goal",
    s.data_classes.length ? s.data_classes.join(",") : "no data classes",
    s.retention_days ? `keep ${s.retention_days} days` : "keep everything",
    n ? `${n} member note${n === 1 ? "" : "s"}` : "no member notes",
  ]
    .join(" · ")
    .slice(0, 240);
}

function parseGoal(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new Error("Goal must be text.");
  const t = v.trim();
  if (!t) return null;
  if (t.length > GOAL_MAX) throw new Error(`Goal must be at most ${GOAL_MAX} characters.`);
  return t;
}

/** A label like "internal" or "customer-pii" (or "内部": letters and digits of any script). Spaces and underscores become hyphens. */
export function normalizeDataClass(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseDataClasses(v: unknown): string[] {
  if (typeof v === "string") {
    if (v.length > 500) throw new Error(`At most ${DATA_CLASSES_MAX} data classes.`);
    return parseDataClasses(v.split(","));
  }
  if (!Array.isArray(v)) throw new Error("Data classes are a list of labels, or a comma-separated list.");
  if (v.length > DATA_CLASSES_MAX) throw new Error(`At most ${DATA_CLASSES_MAX} data classes.`);
  const out: string[] = [];
  for (const item of v) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const label = normalizeDataClass(raw);
    if (!label) throw new Error("Data classes use letters, digits and hyphens (e.g. internal, customer-pii).");
    if (label.length > DATA_CLASS_LEN) throw new Error(`A data class must be at most ${DATA_CLASS_LEN} characters.`);
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > DATA_CLASSES_MAX) throw new Error(`At most ${DATA_CLASSES_MAX} data classes.`);
  return out;
}

/** Days to keep messages, or null to keep everything. Matches the retention route: 0 and "" clear it. */
export function parseRetentionDays(v: unknown): number | null {
  if (v == null || v === "" || v === 0 || v === "0") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) throw new Error(`Retention must be 1–${RETENTION_MAX_DAYS} days, or empty to keep everything.`);
  const days = Math.floor(n);
  if (days < 1 || days > RETENTION_MAX_DAYS) throw new Error(`Retention must be 1–${RETENTION_MAX_DAYS} days, or empty to keep everything.`);
  return days;
}

function parseNote(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new Error("A member note is text.");
  const t = v.trim();
  if (!t) return null;
  if (t.length > MEMBER_NOTE_MAX) throw new Error(`A member note must be at most ${MEMBER_NOTE_MAX} characters.`);
  return t;
}

function parseMemberNotes(v: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const add = (user: string, note: unknown) => {
    const u = user.trim();
    if (!USER_RE.test(u)) throw new Error("Member notes name a person on the board.");
    out[u] = parseNote(note);
  };
  if (Array.isArray(v)) {
    if (v.length > 50) throw new Error("At most 50 member notes.");
    for (const item of v) {
      if (!item || typeof item !== "object") throw new Error("Each member note is {user, note}.");
      const o = item as Record<string, unknown>;
      if (typeof o.user !== "string") throw new Error("Each member note needs a user.");
      add(o.user, "note" in o ? o.note : null);
    }
  } else if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > 50) throw new Error("At most 50 member notes.");
    for (const [user, note] of entries) add(user, note);
  } else throw new Error("members is a list of {user, note}, or an object of user to note.");
  return out;
}

/** Checks a charter write. Only keys present on the object are changed. */
export function parseCharterPatch(raw: unknown): CharterPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Send a JSON object.");
  const r = raw as Record<string, unknown>;
  const patch: CharterPatch = {};
  if ("goal" in r) patch.goal = parseGoal(r.goal);
  if ("data_classes" in r) patch.data_classes = parseDataClasses(r.data_classes);
  if ("retention_days" in r) patch.retention_days = parseRetentionDays(r.retention_days);
  if ("members" in r) patch.notes = parseMemberNotes(r.members);
  return patch;
}

/**
 * Applies a patch. Notes for people who are not in `memberUsers` are dropped (they left).
 * A note for someone who is not a member is refused.
 */
export function applyCharter(current: StoredCharter, patch: CharterPatch, memberUsers: readonly string[]): StoredCharter {
  const allowed = new Set(memberUsers);
  const next: StoredCharter = {
    goal: patch.goal !== undefined ? patch.goal : current.goal,
    data_classes: patch.data_classes !== undefined ? [...patch.data_classes] : [...current.data_classes],
    retention_days: patch.retention_days !== undefined ? patch.retention_days : current.retention_days,
    notes: { ...current.notes },
  };
  if (patch.notes) {
    for (const [user, note] of Object.entries(patch.notes)) {
      if (!allowed.has(user)) throw new Error(`${user} isn't a member.`);
      if (note) next.notes[user] = note;
      else delete next.notes[user];
    }
  }
  for (const user of Object.keys(next.notes)) if (!allowed.has(user)) delete next.notes[user];
  return next;
}

/** Text a secret scan should see: the goal, the labels, and the notes. */
export function charterScanFields(s: StoredCharter, patch: CharterPatch): Record<string, string | null> {
  const fields: Record<string, string | null> = {};
  if (patch.goal !== undefined) fields.goal = s.goal;
  if (patch.data_classes !== undefined) fields.data_classes = s.data_classes.join(" ");
  if (patch.notes) fields.notes = Object.values(s.notes).join("\n");
  return fields;
}

/** What agents are told (#3685): the goal, the data classes and how long messages stay; member notes stay on the web.
 *  Mirrored into the board's Durable Object, so every read (MCP, REST, the CLI) can say it without a D1 query. */
export interface AgentCharter {
  goal: string | null;
  data_classes: string[];
  retention_days: number | null;
}

/** The agents' copy of a stored charter, or null when it says nothing. */
export function agentCharter(s: StoredCharter): AgentCharter | null {
  return s.goal || s.data_classes.length || s.retention_days ? { goal: s.goal, data_classes: [...s.data_classes], retention_days: s.retention_days } : null;
}

/** Reads the mirrored copy back (the Durable Object's meta); anything unreadable is no charter. */
export function parseAgentCharter(raw: string | null | undefined): AgentCharter | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AgentCharter>;
    const c: AgentCharter = {
      goal: typeof v.goal === "string" && v.goal.trim() ? v.goal : null,
      data_classes: Array.isArray(v.data_classes) ? v.data_classes.filter((x): x is string => typeof x === "string" && !!x) : [],
      retention_days: typeof v.retention_days === "number" && v.retention_days > 0 ? v.retention_days : null,
    };
    return c.goal || c.data_classes.length || c.retention_days ? c : null;
  } catch {
    return null;
  }
}

/** The board summary's charter line for agents, or null when there's no charter. */
export function charterLine(c: AgentCharter | null | undefined): string | null {
  if (!c) return null;
  const bits: string[] = [];
  if (c.goal) bits.push(`goal: ${c.goal.replace(/\s+/g, " ")}`);
  if (c.data_classes.length) bits.push(`data classes: ${c.data_classes.join(", ")} (post nothing outside them)`);
  if (c.retention_days) bits.push(`messages are kept ${c.retention_days} days`);
  return bits.length ? `Charter: ${bits.join(" · ")}` : null;
}
