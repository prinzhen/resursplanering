ALTER TABLE activities ADD COLUMN priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5);
--> statement-breakpoint
CREATE TABLE activity_priority_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 5),
  changed_by INTEGER REFERENCES user_accounts(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'excel',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(activity_id,effective_from)
);
--> statement-breakpoint
CREATE INDEX idx_activity_priority_history_date ON activity_priority_history(activity_id,effective_from);
