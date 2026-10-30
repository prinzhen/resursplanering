CREATE TABLE employee_groups (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL UNIQUE,
 description TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE employee_group_members (
 group_id INTEGER NOT NULL REFERENCES employee_groups(id) ON DELETE CASCADE,
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 PRIMARY KEY(group_id,employee_id)
);
--> statement-breakpoint
CREATE INDEX idx_employee_group_members_employee ON employee_group_members(employee_id,group_id);
