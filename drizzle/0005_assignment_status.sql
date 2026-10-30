-- Individual status is authoritative for each employee's assignment.
-- NULL means a legacy assignment whose status is inherited from its project activity.
ALTER TABLE assignments ADD COLUMN work_status TEXT;
--> statement-breakpoint
ALTER TABLE assignments ADD COLUMN original_end_date TEXT;
--> statement-breakpoint
ALTER TABLE assignments ADD COLUMN status_updated_at TEXT;
--> statement-breakpoint
-- Freeze legacy per-person status before any later import changes shared project status.
UPDATE assignments
SET work_status=CASE
 WHEN completed_at IS NOT NULL THEN 'Klar'
 ELSE COALESCE((SELECT status FROM activities WHERE activities.id=assignments.activity_id),'Planerad')
 END,
 original_end_date=end_date
WHERE work_status IS NULL;
--> statement-breakpoint
CREATE TABLE individual_import_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 employee_id INTEGER NOT NULL,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 row_count INTEGER NOT NULL,
 created_count INTEGER NOT NULL,
 updated_count INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_individual_import_runs_employee ON individual_import_runs(employee_id,imported_at);
