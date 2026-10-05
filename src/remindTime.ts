export type ReminderChoice = "hour" | "tonight" | "tomorrow";
/** Browser local time; Date resolves skipped DST hours and chooses the earlier repeated hour. */
export function reminderAt(choice: ReminderChoice, now = new Date()): Date {
  if (choice === "hour") return new Date(now.getTime() + 60 * 60_000);
  const at = new Date(now);
  if (choice === "tomorrow") at.setDate(at.getDate() + 1);
  at.setHours(choice === "tonight" ? 20 : 9, 0, 0, 0);
  if (choice === "tonight" && at <= now) at.setDate(at.getDate() + 1);
  return at;
}
export const REMIND_BROWSER_JS = `
function reminderAt(choice,now=new Date()){if(choice==='hour')return new Date(now.getTime()+3600000);const at=new Date(now);if(choice==='tomorrow')at.setDate(at.getDate()+1);at.setHours(choice==='tonight'?20:9,0,0,0);if(choice==='tonight'&&at<=now)at.setDate(at.getDate()+1);return at}
async function remindItem(id,choice){const r=await fetch('/api/inbox/'+id+'/remind',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({at:reminderAt(choice).toISOString()})});if(!r.ok){toast(tr('Could not set reminder'));return false}window.inboxRefresh?.();toast(tr('Reminder set'));return true}
`;
