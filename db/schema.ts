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
  code: text("code"), workPackageId: integer("work_package_id").references(() => workPackages.id),
  parentActivityId: integer("parent_activity_id"), description: text("description"),
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
