-- Authentication, explicit project leadership, team leadership and allocation approvals.
CREATE TABLE user_accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_id INTEGER UNIQUE REFERENCES employees(id) ON DELETE SET NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_salt TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
 is_group_manager INTEGER NOT NULL DEFAULT 0 CHECK(is_group_manager IN (0,1)),
 is_disabled INTEGER NOT NULL DEFAULT 0 CHECK(is_disabled IN (0,1)),
 failed_attempts INTEGER NOT NULL DEFAULT 0,
 locked_until INTEGER,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE user_sessions (
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_user_sessions_expiry ON user_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE project_leaders (
 project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 PRIMARY KEY(project_id,employee_id)
);
--> statement-breakpoint
CREATE TABLE team_leaders (
 team_id INTEGER NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 PRIMARY KEY(team_id,employee_id)
);
--> statement-breakpoint
CREATE TABLE assignment_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
 requested_by INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 effort_percent INTEGER NOT NULL CHECK(effort_percent BETWEEN 0 AND 200),
 start_date TEXT NOT NULL,
 end_date TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
 comment TEXT,
 decided_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(requested_by<>recipient_id),
 CHECK(start_date<=end_date)
);
--> statement-breakpoint
CREATE INDEX idx_assignment_requests_recipient_status ON assignment_requests(recipient_id,status);
