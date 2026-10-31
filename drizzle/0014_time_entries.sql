-- Work-time accounting is separate from planned resource utilization.
-- Never delete historical reported hours when a person or activity is removed.
CREATE TABLE time_entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
 activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
 work_date TEXT NOT NULL CHECK(length(work_date)=10),
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 duration_seconds INTEGER,
 note TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'timer' CHECK(source IN ('timer','manual','adjusted')),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 deleted_at INTEGER,
 CHECK ((ended_at IS NULL AND duration_seconds IS NULL AND deleted_at IS NULL) OR
        (ended_at IS NOT NULL AND duration_seconds IS NOT NULL AND duration_seconds>=0)),
 CHECK (ended_at IS NULL OR ended_at>=started_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_time_entries_one_running ON time_entries(employee_id) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_time_entries_employee_date ON time_entries(employee_id,work_date,id);
--> statement-breakpoint
CREATE INDEX idx_time_entries_activity_date ON time_entries(activity_id,work_date);
--> statement-breakpoint
CREATE TABLE time_entry_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 time_entry_id INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE RESTRICT,
 actor_account_id INTEGER REFERENCES user_accounts(id) ON DELETE SET NULL,
 action TEXT NOT NULL CHECK(action IN ('start','stop','manual','update','delete')),
 old_seconds INTEGER,
 new_seconds INTEGER,
 changed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX idx_time_entry_audit_entry ON time_entry_audit(time_entry_id,id);
