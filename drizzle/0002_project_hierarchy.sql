ALTER TABLE `projects` ADD `parent_project_id` integer REFERENCES projects(id);
--> statement-breakpoint
CREATE INDEX `idx_projects_parent_project_id` ON `projects` (`parent_project_id`);
