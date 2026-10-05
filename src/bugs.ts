// Bug reports from the web app and the iOS app (jxn #3336, split with vedu's agent #3337): a conspicuous
// button captures a screenshot, the reporter sees it and can drop it (it can show private chats), and the
// report lands on the developers' bug board (the BUGS_BOARD var; without it the endpoint says it's not set up).
// Signed-in reporters are limited per person; signed-out ones strictly per IP (appSignin's fixed-window limiter).

export const BUG_NOTE_MAX = 2000;
export const BUG_PATH_MAX = 300;
export const BUG_CONTEXT_MAX = 1000;
export const BUG_SCREENSHOT_MAX = 2_000_000; // ~2 MB: a phone or desktop window at PNG size; all of a report's pictures together
export const BUG_PICTURES_MAX = 4; // pictures in one report (jxn #4116: the web attaches them like the composer)
const SCREENSHOT_MIMES = ["image/png", "image/jpeg"];
/** Every report is posted by this one member of the bug board; the reporter is named in the text (opus-d #3416). */
export const BUG_BOT = "bugs";

export interface BugReport {
  note: string;
  path: string;
  context: { app_version?: string; device?: string; os?: string; board?: string };
  screenshot: { bytes: ArrayBuffer; mime: string; name: string } | null; // the first picture (the app sends one)
  screenshots?: { bytes: ArrayBuffer; mime: string; name: string }[]; // every picture, in order (one or more `screenshot` parts)
}

/** Pure parts (parse/validate/render) are here so tests can run without a Worker; the route in index.ts calls them. */

/** Reads the multipart form of POST /api/bugs; throws a plain-language message when anything is off. */
export async function parseBugForm(
  request: Request,
): Promise<BugReport> {
  const form = await request.formData().catch(() => null);
  if (!form) throw new Error("Send the bug report as multipart/form-data with a `note` part.");
  const note = (typeof form.get("note") === "string" ? (form.get("note") as string) : "").trim();
  if (!note) throw new Error("Say what went wrong (a `note` part), so the report isn't just a picture.");
  if (note.length > BUG_NOTE_MAX) throw new Error(`Keep the note under ${BUG_NOTE_MAX} characters.`);
  const path = (typeof form.get("path") === "string" ? (form.get("path") as string) : "").slice(0, BUG_PATH_MAX);
  let context: BugReport["context"] = {};
  const raw = typeof form.get("context") === "string" ? (form.get("context") as string) : "";
  if (raw) {
    if (raw.length > BUG_CONTEXT_MAX) throw new Error("The context blob is too long.");
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error("The context part must be JSON: {app_version, device, os, board}.");
    }
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const pick = (k: string) => {
        const v = (j as Record<string, unknown>)[k];
        return typeof v === "string" ? v.slice(0, 120) : undefined;
      };
      context = { app_version: pick("app_version"), device: pick("device"), os: pick("os"), board: pick("board") };
    }
  }
  // One or more `screenshot` parts (the web sends each attached picture as one), each a PNG/JPEG file or data URL,
  // at most BUG_PICTURES_MAX, all of them together within BUG_SCREENSHOT_MAX.
  const parts = form.getAll("screenshot").filter((x) => typeof x !== "string" || x);
  if (parts.length > BUG_PICTURES_MAX) throw new Error(`At most ${BUG_PICTURES_MAX} pictures in one report.`);
  const screenshots: NonNullable<BugReport["screenshot"]>[] = [];
  let total = 0;
  for (const [i, shot] of parts.entries()) {
    const suffix = parts.length > 1 ? `-${i + 1}` : "";
    let pic: NonNullable<BugReport["screenshot"]>;
    if (typeof shot !== "string") {
      if (shot.size > BUG_SCREENSHOT_MAX) throw new Error("The screenshot is too large (max 2 MB).");
      const mime = (shot.type || "").split(";")[0];
      if (!SCREENSHOT_MIMES.includes(mime)) throw new Error("The screenshot must be a PNG or a JPEG.");
      pic = { bytes: await shot.arrayBuffer(), mime, name: `bug-${Date.now()}${suffix}.${mime === "image/png" ? "png" : "jpg"}` };
    } else {
      // a string part: they sent it as a data URL — accept a base64 PNG/JPEG data URL up to the same cap
      const m = shot.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/s);
      if (!m) throw new Error("The screenshot must be a PNG or JPEG file part (or a data URL of one).");
      const bytes = Uint8Array.from(atobUniversal(m[2]), (c) => c.charCodeAt(0));
      if (bytes.byteLength > BUG_SCREENSHOT_MAX) throw new Error("The screenshot is too large (max 2 MB).");
      pic = { bytes: bytes.buffer, mime: m[1], name: `bug-${Date.now()}${suffix}.${m[1] === "image/png" ? "png" : "jpg"}` };
    }
    total += pic.bytes.byteLength;
    if (total > BUG_SCREENSHOT_MAX) throw new Error("The pictures are too large together (max 2 MB).");
    screenshots.push(pic);
  }
  return { note, path, context, screenshot: screenshots[0] ?? null, screenshots };
}

function atobUniversal(s: string): string {
  // The workers runtime and node ≥16 both have atob; the data-URL path is the app's fallback, so keep it dependency-free.
  return atob(s);
}

/** The entry's text: the note first, then what we know, one fact per line (the screenshot rides along as a file). */
export function bugReportText(report: BugReport, by: string): string {
  const lines = [`🐞 ${report.note}`];
  lines.push("", `Reported by ${by}${report.path ? ` · on ${report.path}` : ""}`);
  const c = report.context;
  if (c.app_version) lines.push(`App: ${c.app_version}`);
  if (c.device || c.os) lines.push(`Device: ${[c.device, c.os].filter(Boolean).join(" · ")}`);
  if (c.board) lines.push(`Board: ${c.board}`);
  return lines.join("\n");
}

/** Rate-limit keys: signed-in per person, signed-out strictly per IP (moby #3342). */
export function bugLimitKeys(user: string | null, ip: string): { key: string; limit: number }[] {
  return user ? [{ key: `bugs:u:${user}`, limit: 5 }] : [{ key: `bugs:ip:${ip}`, limit: 3 }];
}
