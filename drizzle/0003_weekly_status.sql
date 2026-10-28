CREATE TABLE IF NOT EXISTS weekly_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uid TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  project_id INTEGER REFERENCES projects(id),
  week_start TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'plan',
  title TEXT NOT NULL,
  planned_hours REAL NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'Planerad',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_weekly_items_employee_week ON weekly_items(employee_id,week_start);
CREATE TABLE IF NOT EXISTS weekly_project_state (
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  activity_state TEXT NOT NULL DEFAULT 'Aktiv',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(employee_id,project_id)
);