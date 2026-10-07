/** Make untrusted text inert before writing it to a terminal. Newlines and tabs remain readable. */
export function terminalSafe(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => {
    const n = c.charCodeAt(0);
    return n <= 0xff ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  }).replace(/\r/g, "\\r");
}

/** Commands are shown literally; controls (including line breaks) are escaped so they cannot forge the prompt. */
export function displayCommand(command: string): string {
  return /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(command)
    ? JSON.stringify(command.replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`))
    : command;
}
