#!/usr/bin/env python3
"""Read-only cross-check of the active test API against its SQLite/D1 state."""
import json
import pathlib
import sqlite3
import sys
import urllib.parse
import urllib.request

DB_ROOT = pathlib.Path("/var/lib/resursplanering-test-excel/data/v3/d1")
DB_FILES = [x for x in DB_ROOT.glob("**/*.sqlite") if x.name != "metadata.sqlite"]
if len(DB_FILES) != 1:
    sys.exit(f"Expected exactly one app database, found {len(DB_FILES)}: {DB_FILES}")
db = sqlite3.connect(f"file:{DB_FILES[0]}?mode=ro", uri=True)
db.row_factory = sqlite3.Row

def fetch(path):
    with urllib.request.urlopen("http://127.0.0.1:3100" + path, timeout=12) as response:
        return json.load(response)

people = db.execute("SELECT id, name, email FROM employees ORDER BY id").fetchall()
errors = []
print("Read-only consistency check: SQLite ↔ API /individual ↔ API /data\n")
app = fetch("/api/data")
for person in people:
    email = person["email"]
    result = fetch("/api/individual?email=" + urllib.parse.quote(email))
    exported = result.get("activities", [])
    assignments = db.execute("""
        SELECT s.activity_id id, s.effort_percent effort, s.start_date start_date,
               s.end_date end_date, s.completed_at completed_at, s.work_status work_status,
               a.name name, a.status project_status
        FROM assignments s JOIN activities a ON a.id=s.activity_id
        WHERE s.employee_id=? ORDER BY a.id
    """, (person["id"],)).fetchall()
    print(f"{person['name']}: {len(assignments)} tilldelningar, {len(exported)} aktiviteter i API-export")
    uid_map = {row["item_uid"]: row["activity_id"] for row in
               db.execute("SELECT item_uid, activity_id FROM individual_form_items WHERE employee_id=?", (person["id"],))}
    seen = set()
    for row in exported:
        uid = str(row["uid"])
        activity_id = uid_map.get(uid)
        if activity_id is None and uid.startswith("activity-"):
            try: activity_id = int(uid.split("-")[1])
            except ValueError: pass
        if activity_id is None and uid.startswith(f"employee-{person['id']}-activity-"):
            try: activity_id = int(uid.rsplit("-", 1)[1])
            except ValueError: pass
        if activity_id is None:
            errors.append(f"Unknown Excel activity ID {uid} for {person['name']}")
        if activity_id in seen:
            errors.append(f"Duplicate activity {activity_id} in API export for {person['name']}")
        seen.add(activity_id)
        assigned = next((a for a in assignments if a["id"] == activity_id), None)
        if not assigned:
            errors.append(f"API exports unassigned activity {uid} for {person['name']}")
            continue
        expected = assigned["work_status"] or assigned["project_status"]
        if expected == "Pågår": expected = "Pågående"
        if row["status"] != expected:
            errors.append(f"Wrong export status: {person['name']}, {assigned['name']}: API {row['status']}, DB {expected}")
        if assigned["completed_at"] and row["status"] != "Klar":
            errors.append(f"Completed assignment exports non-completed: {person['name']}, {assigned['name']}")
    missing = [a["name"] for a in assignments if a["id"] not in seen]
    if missing:
        errors.append(f"Missing export for {person['name']}: {', '.join(missing)}")
    api_assignments = {(int(a["activityId"]), int(a["employeeId"])):a for a in app["assignments"]}
    for row in assignments:
        aid = row["id"]
        api = api_assignments.get((aid, person["id"]))
        if not api:
            errors.append(f"Missing /api/data assignment {person['name']} activity={aid}")
            continue
        for column,api_col in (("start_date","startDate"),("end_date","endDate"),("completed_at","completedAt"),("work_status","workStatus")):
            if row[column] != api.get(api_col):
                errors.append(f"/api/data mismatch {person['name']} activity={aid} {column}: SQLite={row[column]} API={api.get(api_col)}")
    last = db.execute("SELECT row_count, imported_at FROM individual_import_runs WHERE employee_id=? ORDER BY id DESC LIMIT 1",(person["id"],)).fetchone()
    if last and last["row_count"] < len(assignments):
        print(f"  OBS senaste importen ({last['imported_at']}) innehöll {last['row_count']} av {len(assignments)} tilldelningar; övriga behöll tidigare status")
    for row in assignments:
        if row["completed_at"] and row["completed_at"] < row["start_date"]:
            print(f"  OBS {row['name']}: klar {row['completed_at']} före planerad start {row['start_date']} (Gantt ska visa avslutsmarkör)")

if errors:
    print("\nKONTROLLEN HITTADE FEL:")
    for problem in errors: print("  ❌", problem)
    sys.exit(1)
print("\nOK: Inga saknade aktiviteter eller skillnader i individuell status/datum mellan API och databas.")
