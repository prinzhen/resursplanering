ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 3;
--> statement-breakpoint
CREATE TABLE employee_project_orders (
 employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 sort_order INTEGER NOT NULL,
 PRIMARY KEY(employee_id,project_id)
);
--> statement-breakpoint
CREATE INDEX idx_employee_project_orders_employee ON employee_project_orders(employee_id,sort_order);
