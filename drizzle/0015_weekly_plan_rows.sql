CREATE TABLE `weekly_plan_rows` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `row_key` text NOT NULL,
  `employee_id` integer NOT NULL REFERENCES `employees`(`id`) ON DELETE RESTRICT,
  `activity_id` integer NOT NULL REFERENCES `activities`(`id`) ON DELETE RESTRICT,
  `iso_week` text NOT NULL,
  `weekday` integer,
  `duration_days` integer NOT NULL,
  `effort_percent` real,
  `planned_hours` real,
  `work_type` text NOT NULL DEFAULT '',
  `status` text NOT NULL DEFAULT 'Planerad',
  `priority` integer,
  `deadline` text,
  `first_planned_week` text NOT NULL,
  `comment` text NOT NULL DEFAULT '',
  `move_reason` text NOT NULL DEFAULT '',
  `revision` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `weekly_day_range` CHECK (`weekday` IS NULL OR `weekday` BETWEEN 1 AND 7),
  CONSTRAINT `weekly_duration_positive` CHECK (`duration_days` BETWEEN 1 AND 3650),
  CONSTRAINT `weekly_effort_range` CHECK (`effort_percent` IS NULL OR `effort_percent` BETWEEN 0 AND 100),
  CONSTRAINT `weekly_hours_nonnegative` CHECK (`planned_hours` IS NULL OR `planned_hours` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_plan_rows_key_unique` ON `weekly_plan_rows` (`row_key`);
--> statement-breakpoint
CREATE INDEX `weekly_plan_rows_employee_week` ON `weekly_plan_rows` (`employee_id`,`iso_week`);
--> statement-breakpoint
CREATE INDEX `weekly_plan_rows_activity_id` ON `weekly_plan_rows` (`activity_id`);
--> statement-breakpoint
CREATE TABLE `weekly_plan_row_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `row_key` text NOT NULL,
  `revision` integer NOT NULL,
  `action` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `changed_by_account_id` integer REFERENCES `user_accounts`(`id`) ON DELETE SET NULL,
  `changed_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_plan_history_revision_unique` ON `weekly_plan_row_history` (`row_key`,`revision`);
