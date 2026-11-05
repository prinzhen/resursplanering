-- Durable, independent audit of administrative relocation and permanent removal.
-- No FKs on historical snapshots: the source activity/project may be deleted.
CREATE TABLE time_entry_relocations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 entry_id INTEGER NOT NULL,
 employee_id INTEGER NOT NULL,
 original_project_id INTEGER NOT NULL,
 original_project_code TEXT NOT NULL,
 original_project_name TEXT NOT NULL,
 original_activity_id INTEGER NOT NULL,
 original_activity_code TEXT,
 original_activity_name TEXT NOT NULL,
 target_project_id INTEGER NOT NULL,
 target_project_code TEXT NOT NULL,
 target_project_name TEXT NOT NULL,
 target_activity_id INTEGER NOT NULL,
 target_activity_code TEXT,
 target_activity_name TEXT NOT NULL,
 work_date TEXT NOT NULL,
 duration_seconds INTEGER,
 actor_account_id INTEGER NOT NULL,
 occurred_at INTEGER NOT NULL,
 reason TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_time_entry_relocations_entry ON time_entry_relocations(entry_id,occurred_at);
--> statement-breakpoint
CREATE TABLE time_entry_removal_archive (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 source_event_id INTEGER NOT NULL UNIQUE,
 original_entry_id INTEGER NOT NULL,
 employee_id INTEGER NOT NULL,
 employee_email TEXT NOT NULL,
 employee_name TEXT NOT NULL,
 original_project_id INTEGER NOT NULL,
 original_project_code TEXT NOT NULL,
 original_project_name TEXT NOT NULL,
 original_activity_id INTEGER NOT NULL,
 original_activity_code TEXT,
 original_activity_name TEXT NOT NULL,
 work_date TEXT NOT NULL,
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 duration_seconds INTEGER,
 note TEXT NOT NULL,
 source TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 was_deleted INTEGER NOT NULL,
 removed_by_account_id INTEGER NOT NULL,
 removed_at INTEGER NOT NULL,
 removal_reason TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_time_entry_removal_archive_entry ON time_entry_removal_archive(original_entry_id);
