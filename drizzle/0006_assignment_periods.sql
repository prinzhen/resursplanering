CREATE TABLE assignment_periods (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
 start_date TEXT NOT NULL,
 end_date TEXT NOT NULL,
 effort_percent INTEGER NOT NULL CHECK(effort_percent>=0 AND effort_percent<=200),
 CHECK(start_date<=end_date)
);
--> statement-breakpoint
CREATE INDEX idx_assignment_periods_assignment_dates ON assignment_periods(assignment_id,start_date,end_date);
--> statement-breakpoint
-- Existing plans become an initial period without discarding either their
-- completion history or previously planned end date.
INSERT INTO assignment_periods(assignment_id,start_date,end_date,effort_percent)
 SELECT id,start_date,COALESCE(original_end_date,end_date),effort_percent FROM assignments
 WHERE start_date<=COALESCE(original_end_date,end_date);
