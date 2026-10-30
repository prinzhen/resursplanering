ALTER TABLE `assignments` ADD COLUMN `completed_at` text;
--> statement-breakpoint
CREATE INDEX `idx_assignments_completed_at` ON `assignments` (`completed_at`);
