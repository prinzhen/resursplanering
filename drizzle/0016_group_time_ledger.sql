-- Group-owned historical time without linking it to a former physical person.
-- Keep time_entries FK intact by reattributing rows to a non-person ledger
-- employee that is excluded from the staff directory and planning resources.
ALTER TABLE employees ADD COLUMN is_group_ledger INTEGER NOT NULL DEFAULT 0 CHECK(is_group_ledger IN (0,1));
--> statement-breakpoint
ALTER TABLE employees ADD COLUMN ledger_group_id INTEGER REFERENCES employee_groups(id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_employees_ledger_group ON employees(ledger_group_id) WHERE is_group_ledger=1;
--> statement-breakpoint
ALTER TABLE time_entries ADD COLUMN reporting_group_id INTEGER REFERENCES employee_groups(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE time_entries ADD COLUMN reporting_group_name TEXT;
--> statement-breakpoint
CREATE INDEX idx_time_entries_reporting_group ON time_entries(reporting_group_id,work_date);
