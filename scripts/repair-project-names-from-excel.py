#!/usr/bin/env python3
"""Preview and safely correct project names from weekly-planning XLSX column D.

Only projects.name is updated; no activities, allocations, or hours are changed.
Default is read-only dry-run. Explicit --apply and --expected-changes required.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
from pathlib import Path
import sqlite3
import sys
from collections import defaultdict
from urllib.parse import quote
from xml.etree import ElementTree as ET
from zipfile import ZipFile, BadZipFile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

def sheet_cells(path: Path) -> dict[str, str]:
    with ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.iter(NS + "t"))
                      for si in root.iter(NS + "si")]
        if "xl/worksheets/sheet1.xml" not in archive.namelist():
            raise ValueError("Första kalkylbladet saknas")
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        result = {}
        for cell in root.iter(NS + "c"):
            ref = cell.get("r")
            if not ref:
                continue
            typ = cell.get("t")
            if typ == "inlineStr":
                value = "".join(t.text or "" for t in cell.iter(NS + "t"))
            else:
                v = cell.find(NS + "v")
                value = v.text if v is not None and v.text else ""
                if typ == "s":
                    index = int(value)
                    value = shared[index]
            result[ref] = value.strip()
        return result

def candidates(folder: Path):
    entries = defaultdict(list)
    files = sorted(p for p in folder.rglob("*.xlsx") if not p.name.startswith("~$"))
    if not files:
        raise ValueError("Inga XLSX-filer hittades")
    failures = []
    for path in files:
        try:
            cells = sheet_cells(path)
            header = 8 if cells.get("A8", "").lower().startswith("vecka") else 7 if cells.get("A7", "").lower().startswith("vecka") else None
            if header is None:
                failures.append((str(path), "Fel mall: Vecka saknas i A8/A7"))
                continue
            last = 68 if header == 8 else 70
            for row in range(header + 1, last + 1):
                activity = cells.get(f"B{row}", "").strip()
                code = cells.get(f"E{row}", "").strip().upper()
                name = cells.get(f"D{row}", "").strip()
                typ = cells.get(f"C{row}", "").strip()
                if not activity or typ != "Projekt" or not code or code.startswith("INTERNAL-"):
                    continue
                if not name:
                    failures.append((f"{path.name}:{row}", "Projekt saknar namn i D"))
                    continue
                entries[code].append((name, path.name, row))
        except (BadZipFile, ValueError, ET.ParseError, KeyError, OSError) as ex:
            failures.append((str(path), f"Kan inte läsa: {ex}"))
    return entries, failures, len(files)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, type=Path, help="SQLite databasfil (inte katalog)")
    parser.add_argument("--excel-dir", required=True, type=Path)
    parser.add_argument("--report", type=Path, default=Path("./projektkorrigering.csv"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-changes", type=int)
    args = parser.parse_args()
    if not args.db.is_file():
        parser.error("Databasfilen saknas")
    if not args.excel_dir.is_dir():
        parser.error("Excel-katalogen saknas")
    if args.apply and (args.expected_changes is None or args.expected_changes < 1):
        parser.error("--apply kräver --expected-changes N (>0)")
    entries, failures, count = candidates(args.excel_dir)
    if failures:
        for location, msg in failures:
            print(f"VARNING {location}: {msg}", file=sys.stderr)
    conflicts = {}
    names = {}
    for code, items in entries.items():
        unique = {name.casefold(): name for name, _, _ in items}
        if len(unique) != 1:
            conflicts[code] = sorted(set(name for name, _, _ in items))
        else:
            names[code] = next(iter(unique.values()))
    uri = "file:" + quote(str(args.db.resolve())) + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as readonly:
        rows = readonly.execute("SELECT id,code,name FROM projects").fetchall()
    changes = []
    report_rows = []
    found = set()
    for project_id, code, current_name in rows:
        key = str(code).upper()
        found.add(key)
        if key in conflicts:
            report_rows.append((code, current_name, " / ".join(conflicts[key]), "KONFLIKT"))
        elif key not in names:
            report_rows.append((code, current_name, "", "INGET UNDERLAG"))
        else:
            new = names[key]
            status = "OFÖRÄNDRAT" if current_name == new else "ÄNDRA"
            report_rows.append((code, current_name, new, status))
            if status == "ÄNDRA":
                changes.append((new, project_id, current_name, code))
    for code in sorted(names.keys() - found):
        report_rows.append((code, "", names[code], "SAKNAS I DATABAS"))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    with args.report.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.writer(stream, delimiter=";")
        writer.writerow(("Projektkod", "Nuvarande namn", "Föreslaget namn", "Resultat"))
        writer.writerows(sorted(report_rows, key=lambda row: row[0]))
    print(f"Excel-filer: {count}, projektkoder: {len(entries)}, föreslagna ändringar: {len(changes)}")
    print(f"Konflikter: {len(conflicts)}, varningar: {len(failures)}")
    print(f"Rapport: {args.report}")
    if conflicts:
        print("KONFLIKTER: " + ", ".join(sorted(conflicts)), file=sys.stderr)
    if not args.apply:
        print("DRY RUN: Inget ändrat i databasen.")
        return 0
    if conflicts or failures:
        raise ValueError("Kan inte tillämpa: konflikter/ogiltiga filer måste rättas först")
    if len(changes) != args.expected_changes:
        raise ValueError("Antalet ändringar avviker från --expected-changes, avbryter")
    # Backup via SQLite online backup, avoids inconsistent snapshots when WAL is active.
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = args.db.parent / (args.db.name + ".before-project-rename." + stamp + ".sqlite")
    if backup_path.exists():
        raise ValueError("Säkerhetskopian finns redan")
    with sqlite3.connect(uri, uri=True) as source, sqlite3.connect(str(backup_path)) as target:
        source.backup(target)
    os.chmod(backup_path, 0o600)
    print(f"Säkerhetskopia: {backup_path}")
    with sqlite3.connect(str(args.db), timeout=30) as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            for new, pid, old, code in changes:
                result = db.execute(
                    "UPDATE projects SET name=? WHERE id=? AND code=? AND name=?",
                    (new, pid, code, old))
                if result.rowcount != 1:
                    raise RuntimeError("Databasens innehåll ändrades under arbetet: " + code)
            db.commit()
        except Exception:
            db.rollback()
            raise
    print(f"KLART: {len(changes)} projektnamn uppdaterade, aktiviteter/tid orörda.")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as ex:
        print("FEL:", ex, file=sys.stderr)
        raise SystemExit(1)
