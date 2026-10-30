CREATE TABLE project_proposals (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 submitted_by INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE RESTRICT,
 code TEXT NOT NULL COLLATE NOCASE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL DEFAULT '#2563eb',
 priority INTEGER NOT NULL DEFAULT 3 CHECK(priority BETWEEN 1 AND 5),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 reviewed_by INTEGER REFERENCES user_accounts(id) ON DELETE SET NULL,
 reviewed_at TEXT,
 created_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
 comment TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_project_proposals_status ON project_proposals(status,created_at);
--> statement-breakpoint
CREATE INDEX idx_project_proposals_submitter ON project_proposals(submitted_by,created_at);
