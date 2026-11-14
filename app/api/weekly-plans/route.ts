import { env } from "cloudflare:workers";
export const dynamic = "force-dynamic";

/** Läs-API. Skrivoperationer aktiveras först efter rollkontroll och importförhandsgranskning. */
export async function GET(request: Request) {
  try {
    if (!env.DB) return Response.json({error:"Databasen är inte tillgänglig."},{status:503});
    const url = new URL(request.url);
    const employee = url.searchParams.get("employeeId");
    const week = url.searchParams.get("week");
    if (employee && (!/^\d+$/.test(employee) || Number(employee) <= 0)) return Response.json({error:"Ogiltigt medarbetar-ID"},{status:400});
    if (week && !/^\d{4}-V\d{2}$/.test(week)) return Response.json({error:"Ogiltigt veckonummer"},{status:400});
    const conditions: string[] = [];
    const values: Array<number|string> = [];
    if (employee) { conditions.push("w.employee_id=?"); values.push(Number(employee)); }
    if (week) { conditions.push("w.iso_week=?"); values.push(week); }
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    const result = await env.DB.prepare(`SELECT w.id planId,w.activity_id activityId,w.employee_id employeeId,w.iso_week week,w.weekday weekday,w.duration_days durationDays,w.effort_percent effortPercent,w.planned_hours plannedHours,w.work_type workType,w.status status,w.priority priority,w.deadline deadline,w.first_planned_week firstPlannedWeek,w.comment comment,w.move_reason moveReason,w.revision revision,a.name activityName,p.code projectCode,p.name projectName,e.name employeeName FROM weekly_plans w JOIN activities a ON a.id=w.activity_id JOIN projects p ON p.id=a.project_id JOIN employees e ON e.id=w.employee_id ${where} ORDER BY w.iso_week,w.weekday,w.id LIMIT 10000`).bind(...values).all();
    return Response.json({rows:result.results});
  } catch (e) {
    console.error(e);
    return Response.json({error:"Kunde inte läsa veckoplaneringen."},{status:500});
  }
}
