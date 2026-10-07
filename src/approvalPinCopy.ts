import { displayCommand, terminalSafe } from "./terminalText";
import { askerOf } from "./approvals";

export const PIN_WARNING = "Never give this PIN to an agent or paste it into a chat.";

export const hiddenPinPrompt = () => `${PIN_WARNING}\nApproval PIN: `;

export function pinApprovalPreview(a: { id: string; user: string; requested_by: string | null; session: string | null; client: string | null; title: string; tool: string | null; command: string | null; risk: string; details: string }): string {
  const line = (s: string | null | undefined) => terminalSafe(s ?? "—").replace(/\s+/g, " ");
  const details = (a.details ?? "").split(/\r?\n/);
  return `Approval ${a.id}\nAsker: ${line(askerOf(a))}\nTitle: ${line(a.title)}\nTool: ${line(a.tool)}\nCommand: ${a.command ? displayCommand(a.command) : "—"}\nRisk: ${line(a.risk)}\nDetails:\n${details.slice(0, 5).map(s => `  ${terminalSafe(s)}`).join("\n")}${details.length > 5 ? "\n  …" : ""}`;
}
