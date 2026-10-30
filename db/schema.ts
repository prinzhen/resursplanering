import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const employees = sqliteTable("employees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(), email: text("email").notNull().unique(),
  role: text("role").notNull().default("Medarbetare"), managerId: integer("manager_id"),
  capacityPercent: integer("capacity_percent").notNull().default(100),
});
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }), code: text("code").notNull().unique(),
  name: text("name").notNull(), color: text("color").notNull().default("#2563eb"),
  priority: integer("priority").notNull().default(3),
  description: text("description"), status: text("status").notNull().default("Aktivt"),
});
export const projectMembers = sqliteTable("project_members", {
  projectId: integer("project_id").notNull().references(() => projects.id),
  employeeId: integer("employee_id").notNull().references(() => employees.id),
}, (table) => [uniqueIndex("idx_project_members_project_employee").on(table.projectId, table.employeeId)]);
export const employeeProjectOrders = sqliteTable("employee_project_orders", {
 employeeId:integer("employee_id").notNull().references(()=>employees.id,{onDelete:"cascade"}),
 projectId:integer("project_id").notNull().references(()=>projects.id,{onDelete:"cascade"}),
 sortOrder:integer("sort_order").notNull(),
},table=>[uniqueIndex("idx_employee_project_orders_employee_project").on(table.employeeId,table.projectId)]);
export const workPackages = sqliteTable("work_packages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull().references(() => projects.id),
  code: text("code").notNull(), name: text("name").notNull(), description: text("description"),
}, (table) => [uniqueIndex("idx_work_packages_project_code").on(table.projectId, table.code)]);
export const activities = sqliteTable("activities", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: integer("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(), startDate: text("start_date").notNull(), endDate: text("end_date").notNull(),
  estimatedHours: integer("estimated_hours"), status: text("status").notNull().default("Planerad"),
  priority:integer("priority").notNull().default(3),
  code: text("code"), workPackageId: integer("work_package_id").references(() => workPackages.id),
  parentActivityId: integer("parent_activity_id"), description: text("description"),createdBy:integer("created_by").references(()=>employees.id,{onDelete:"set null"}),
});
export const assignments = sqliteTable("assignments", {
  id: integer("id").primaryKey({ autoIncrement: true }), activityId: integer("activity_id").notNull().references(() => activities.id),
  employeeId: integer("employee_id").notNull().references(() => employees.id), effortPercent: integer("effort_percent").notNull(),
  startDate: text("start_date").notNull(), endDate: text("end_date").notNull(),
  completedAt: text("completed_at"), workStatus: text("work_status"),
  originalEndDate: text("original_end_date"), statusUpdatedAt: text("status_updated_at"),
}, (table) => [uniqueIndex("idx_assignments_activity_employee").on(table.activityId, table.employeeId)]);

export const assignmentPeriods = sqliteTable("assignment_periods", {
 id: integer("id").primaryKey({autoIncrement:true}),
 assignmentId: integer("assignment_id").notNull().references(() => assignments.id,{onDelete:"cascade"}),
 startDate: text("start_date").notNull(),
 endDate: text("end_date").notNull(),
 effortPercent: integer("effort_percent").notNull(),
});

export const employeeGroups = sqliteTable("employee_groups", {
 id:integer("id").primaryKey({autoIncrement:true}),
 name:text("name").notNull().unique(),
 description:text("description"),
 createdAt:text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});
export const employeeGroupMembers = sqliteTable("employee_group_members",{
 groupId:integer("group_id").notNull().references(()=>employeeGroups.id,{onDelete:"cascade"}),
 employeeId:integer("employee_id").notNull().references(()=>employees.id,{onDelete:"cascade"}),
},t=>[uniqueIndex("idx_employee_group_members_group_employee").on(t.groupId,t.employeeId)]);

export const userAccounts = sqliteTable("user_accounts", {
 id:integer("id").primaryKey({autoIncrement:true}),
 employeeId:integer("employee_id").unique().references(()=>employees.id,{onDelete:"set null"}),
 email:text("email").notNull().unique(),passwordSalt:text("password_salt").notNull(),
 passwordHash:text("password_hash").notNull(),
 isAdmin:integer("is_admin").notNull().default(0),
 isGroupManager:integer("is_group_manager").notNull().default(0),
 isDisabled:integer("is_disabled").notNull().default(0),
 failedAttempts:integer("failed_attempts").notNull().default(0),
 lockedUntil:integer("locked_until"),
 createdAt:text("created_at").notNull()
});
export const userSessions=sqliteTable("user_sessions",{
 tokenHash:text("token_hash").primaryKey(),
 userId:integer("user_id").notNull().references(()=>userAccounts.id,{onDelete:"cascade"}),
 expiresAt:integer("expires_at").notNull(),createdAt:text("created_at").notNull()
});
export const projectLeaders=sqliteTable("project_leaders",{
 projectId:integer("project_id").notNull().references(()=>projects.id,{onDelete:"cascade"}),
 employeeId:integer("employee_id").notNull().references(()=>employees.id,{onDelete:"cascade"})
},t=>[uniqueIndex("idx_project_leaders_project_person").on(t.projectId,t.employeeId)]);
export const teamLeaders=sqliteTable("team_leaders",{
 teamId:integer("team_id").notNull().references(()=>employeeGroups.id,{onDelete:"cascade"}),
 employeeId:integer("employee_id").notNull().references(()=>employees.id,{onDelete:"cascade"})
},t=>[uniqueIndex("idx_team_leaders_team_person").on(t.teamId,t.employeeId)]);
export const assignmentRequests=sqliteTable("assignment_requests",{
 id:integer("id").primaryKey({autoIncrement:true}),
 activityId:integer("activity_id").notNull().references(()=>activities.id,{onDelete:"cascade"}),
 requestedBy:integer("requested_by").notNull().references(()=>employees.id,{onDelete:"cascade"}),
 recipientId:integer("recipient_id").notNull().references(()=>employees.id,{onDelete:"cascade"}),
 effortPercent:integer("effort_percent").notNull(),
 startDate:text("start_date").notNull(),endDate:text("end_date").notNull(),
 status:text("status").notNull().default("pending"),comment:text("comment"),decidedAt:text("decided_at"),createdAt:text("created_at").notNull()
});

export const projectProposals=sqliteTable("project_proposals",{
 id:integer("id").primaryKey({autoIncrement:true}),
 submittedBy:integer("submitted_by").notNull().references(()=>userAccounts.id,{onDelete:"restrict"}),
 code:text("code").notNull(),name:text("name").notNull(),
 description:text("description").notNull().default(""),
 color:text("color").notNull().default("#2563eb"),
 priority:integer("priority").notNull().default(3),
 status:text("status").notNull().default("pending"),
 reviewedBy:integer("reviewed_by").references(()=>userAccounts.id,{onDelete:"set null"}),
 reviewedAt:text("reviewed_at"),
 createdProjectId:integer("created_project_id").references(()=>projects.id,{onDelete:"set null"}),
 comment:text("comment"),
 createdAt:text("created_at").notNull()
});

export const activityPriorityHistory = sqliteTable("activity_priority_history", {
 id:integer("id").primaryKey({autoIncrement:true}),
 activityId:integer("activity_id").notNull().references(()=>activities.id,{onDelete:"cascade"}),
 effectiveFrom:text("effective_from").notNull(),
 priority:integer("priority").notNull(),
 changedBy:integer("changed_by").references(()=>userAccounts.id,{onDelete:"set null"}),
 source:text("source").notNull().default("excel"),
 createdAt:text("created_at").notNull()
},t=>[uniqueIndex("idx_activity_priority_history_activity_date").on(t.activityId,t.effectiveFrom)]);
