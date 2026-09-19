CREATE TABLE `work_packages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_work_packages_project_code` ON `work_packages` (`project_id`,`code`);--> statement-breakpoint
ALTER TABLE `activities` ADD `code` text;--> statement-breakpoint
ALTER TABLE `activities` ADD `work_package_id` integer REFERENCES work_packages(id);--> statement-breakpoint
ALTER TABLE `activities` ADD `parent_activity_id` integer;--> statement-breakpoint
ALTER TABLE `activities` ADD `description` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `description` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `status` text DEFAULT 'Aktivt' NOT NULL;