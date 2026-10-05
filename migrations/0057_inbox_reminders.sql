CREATE TABLE inbox_reminders (
  user TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  PRIMARY KEY (user, notification_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
);
CREATE INDEX inbox_reminders_due ON inbox_reminders(due_at);
CREATE INDEX inbox_reminders_notification ON inbox_reminders(notification_id);
