CREATE TABLE IF NOT EXISTS individual_form_items (
  item_uid TEXT PRIMARY KEY NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  activity_id INTEGER NOT NULL REFERENCES activities(id),
  first_week TEXT NOT NULL,
  current_week TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_form_employee_activity ON individual_form_items(employee_id,activity_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS individual_week_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uid TEXT NOT NULL REFERENCES individual_form_items(item_uid),
  from_week TEXT NOT NULL,
  to_week TEXT NOT NULL,
  reason TEXT,
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_week_moves_item ON individual_week_moves(item_uid);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS individual_project_state (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL DEFAULT 'Aktiv',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(employee_id,project_id)
);