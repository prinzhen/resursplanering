CREATE TABLE `weekly_plans` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `activity_id` integer NOT NULL REFERENCES `activities`(`id`),
  `employee_id` integer NOT NULL REFERENCES `employees`(`id`),
  `iso_week` text NOT NULL,
  `weekday` integer,
  `duration_days` integer NOT NULL,
  `effort_percent` real NOT NULL DEFAULT 100,
  `planned_hours` real NOT NULL DEFAULT 0,
  `work_type` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'Planerad',
  `priority` text NOT NULL DEFAULT 'Normal',
  `deadline` text,
  `first_planned_week` text NOT NULL,
  `comment` text NOT NULL DEFAULT '',
  `move_reason` text NOT NULL DEFAULT '',
  `revision` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (`weekday` IS NULL OR `weekday` BETWEEN 1 AND 7),
  CHECK (`duration_days` > 0),
  CHECK (`effort_percent` BETWEEN 0 AND 100),
  CHECK (`planned_hours` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_weekly_plans_employee_week` ON `weekly_plans` (`employee_id`,`iso_week`);
--> statement-breakpoint
CREATE INDEX `idx_weekly_plans_activity` ON `weekly_plans` (`activity_id`);
--> statement-breakpoint
CREATE TABLE `weekly_plan_revisions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `plan_id` integer NOT NULL REFERENCES `weekly_plans`(`id`),
  `revision` integer NOT NULL,
  `change_type` text NOT NULL,
  `previous_json` text,
  `current_json` text,
  `changed_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `changed_by` text,
  UNIQUE (`plan_id`,`revision`)
);
