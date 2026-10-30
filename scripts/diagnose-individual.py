#!/usr/bin/env python3
"""Read-only diagnostics for the test instance's local D1/SQLite database."""
import argparse, pathlib, sqlite3, sys
p=argparse.ArgumentParser()
p.add_argument("--data-dir",default="/var/lib/resursplanering-test-excel/data")
p.add_argument("--email",default="")
args=p.parse_args()
root=pathlib.Path(args.data_dir).resolve()
dbs=list(root.glob("v3/d1/**/*.sqlite")) + list(root.glob("v3/d1/**/*.db"))
dbs=list(dict.fromkeys(dbs))
if len(dbs)!=1:
 print("Hittade",len(dbs),"databaser:",*[str(x) for x in dbs],sep="\n")
 sys.exit(2)
db=dbs[0]
print("Databas:",db)
con=sqlite3.connect(f"file:{db}?mode=ro",uri=True)
con.row_factory=sqlite3.Row
def show(title,sql,params=()):
 print("\n###",title)
 try:
  rows=con.execute(sql,params).fetchall()
  if not rows:print("(inga rader)")
  for r in rows[:300]:print(" | ".join(f"{k}={r[k]}" for k in r.keys()))
  if len(rows)>300:print("... avkortat till 300")
 except sqlite3.Error as e:print("KAN INTE LÄSA:",e)
tables={r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
show("Tabeller","SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
show("Tilldelningskolumner","PRAGMA table_info(assignments)")
show("Medarbetare","SELECT id,name,email FROM employees ORDER BY id")
flt=" WHERE lower(e.email)=lower(?)" if args.email else ""
params=(args.email,) if args.email else ()
show("Individuella tilldelningar",
 "SELECT e.name person,a.id activity_id,a.name activity,p.code project,a.status project_status,"
 "s.id assignment_id,s.effort_percent effort,s.start_date assignment_start,s.end_date assignment_end,"
 "s.completed_at completed_at"
 +(",s.work_status work_status,s.original_end_date original_end" if "work_status" in [x[1] for x in con.execute("PRAGMA table_info(assignments)")] else "")
 +" FROM assignments s JOIN employees e ON e.id=s.employee_id JOIN activities a ON a.id=s.activity_id "
 "JOIN projects p ON p.id=a.project_id"+flt+" ORDER BY e.name,a.id",params)
if "individual_form_items" in tables:
 show("Excelrad till aktivitet",
 "SELECT e.name person,i.item_uid uid,a.id activity_id,a.name activity,i.current_week,i.first_week,i.updated_at "
 "FROM individual_form_items i JOIN employees e ON e.id=i.employee_id "
 "JOIN activities a ON a.id=i.activity_id"+flt.replace(" WHERE "," WHERE ")+" ORDER BY e.name,a.id",params)
 show("Excelrader utan tilldelning",
 "SELECT i.item_uid,e.name person,a.name activity FROM individual_form_items i "
 "JOIN employees e ON e.id=i.employee_id JOIN activities a ON a.id=i.activity_id "
 "LEFT JOIN assignments s ON s.activity_id=i.activity_id AND s.employee_id=i.employee_id "
 "WHERE s.id IS NULL")
show("Aktiviteter med flera tilldelningar",
 "SELECT a.id,a.name,a.status,COUNT(s.id) assignees,"
 "SUM(CASE WHEN s.completed_at IS NOT NULL THEN 1 ELSE 0 END) finished "
 "FROM activities a JOIN assignments s ON s.activity_id=a.id "
 "GROUP BY a.id HAVING COUNT(s.id)>1 ORDER BY a.id")
if "individual_import_runs" in tables:
 show("Senaste importer","SELECT * FROM individual_import_runs ORDER BY id DESC LIMIT 25")
print("\nOBS: Endast SELECT/PRAGMA; databasen har inte ändrats.")
