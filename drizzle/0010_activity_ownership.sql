ALTER TABLE activities ADD COLUMN created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE employee_groups ADD COLUMN owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
