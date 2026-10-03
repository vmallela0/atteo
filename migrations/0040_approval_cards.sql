-- Approval cards on boards (#977): which agent session asked, and a JSON payload on notifications (an approval's
-- push-ready "approval needed" fields; a workflow trigger's prompt and event).
ALTER TABLE approvals ADD COLUMN session TEXT;
ALTER TABLE notifications ADD COLUMN data TEXT;
CREATE INDEX IF NOT EXISTS approvals_board ON approvals (board_id, user, status);
