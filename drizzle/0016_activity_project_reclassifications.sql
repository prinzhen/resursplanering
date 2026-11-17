-- Reclassification is an audited operation. Past accounting is never silently
-- reassigned by changing activities.project_id.
CREATE TABLE activity_project_reclassifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE RESTRICT,
 source_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 target_project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 effective_from TEXT NOT NULL CHECK(length(effective_from)=10),
 changed_by_account_id INTEGER REFERENCES user_accounts(id) ON DELETE SET NULL,
 changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 note TEXT NOT NULL DEFAULT '',
 CHECK(source_project_id <> target_project_id)
);
--> statement-breakpoint
CREATE INDEX idx_activity_project_reclassifications_activity ON activity_project_reclassifications(activity_id,effective_from);
