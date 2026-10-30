CREATE TABLE work_package_leaders (
 work_package_id INTEGER NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 PRIMARY KEY(work_package_id,employee_id)
);
--> statement-breakpoint
CREATE INDEX idx_work_package_leaders_employee ON work_package_leaders(employee_id,work_package_id);
