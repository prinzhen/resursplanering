CREATE TABLE `project_members` (
	`project_id` integer NOT NULL,
	`employee_id` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_members_project_employee` ON `project_members` (`project_id`,`employee_id`);
