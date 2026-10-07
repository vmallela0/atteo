import { displayCommand, terminalSafe } from "./terminalText";

export const PIN_WARNING = "Never give this PIN to an agent or paste it into a chat.";

export const hiddenPinPrompt = () => `${PIN_WARNING}\nApproval PIN: `;

export function pinApprovalPreview(a: { id: string; user: string; requested_by: string | null; session: string | null; client: string | null; title: string; tool: string | null; command: string | null; risk: string; details: string }): string {
  const line = (s: string | null | undefined) => terminalSafe(s ?? "—").replace(/\s+/g, " ");
  // Every line of details (capped at 20k when filed): a cut preview lets the real action hide past the cut (review #6033).
  const details = (a.details ?? "").split(/\r?\n/);
  // The session/client label is the agent's own choice, so it's marked as one; another person's agent is named by the server.
  const asker = a.requested_by && a.requested_by !== a.user ? `${a.requested_by}'s agent` : `${a.session ?? a.client ?? "your agent"} (agent session)`;
  return `Approval ${a.id}\nAsker: ${line(asker)}\nTitle: ${line(a.title)}\nTool: ${line(a.tool)}\nCommand: ${a.command ? displayCommand(a.command) : "—"}\nRisk: ${line(a.risk)}\nDetails:\n${details.map(s => `  ${terminalSafe(s)}`).join("\n")}`;
}
