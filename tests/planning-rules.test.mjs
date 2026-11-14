import test from "node:test";
import assert from "node:assert/strict";
import { WEEKLY_HEADERS, PROJECT_HEADERS, isoWeek, weekStart, weekDayDate, parseDuration, formatDuration, workingDays, plannedHours, validateWeeklyRow } from "../lib/planning-rules.mjs";

test("kolumnordning är låst till överenskommen XLSX-mall", () => {
  assert.equal(WEEKLY_HEADERS.length, 16);
  assert.deepEqual(WEEKLY_HEADERS.slice(0, 4), ["Vecka", "Dag", "Vad jag skall göra", "Varaktighet"]);
  assert.equal(WEEKLY_HEADERS[15], "Aktivitets-ID");
  assert.equal(PROJECT_HEADERS.includes("Startdatum"), true);
  assert.equal(PROJECT_HEADERS.includes("Slutdatum"), true);
});
test("ISO-vecka vid årsskifte", () => {
  assert.equal(isoWeek("2027-01-01"), "2026-V53");
  assert.equal(weekStart("2026-V53").toISOString().slice(0, 10), "2026-12-28");
  assert.equal(weekDayDate("2026-V40", "Torsdag"), "2026-10-01");
  assert.throws(() => weekStart("2026-V54"));
});
test("varaktighet är kalendertid, 7 dagar visas i dagar och 14 i veckor", () => {
  assert.equal(parseDuration("2 veckor"), 14);
  assert.equal(parseDuration("7 dagar"), 7);
  assert.equal(formatDuration(7), "7 dagar");
  assert.equal(formatDuration(14), "2 veckor");
  assert.equal(formatDuration(9), "1 vecka 2 dagar");
});
test("40 timmars arbetsvecka, 8 timmar per dag, helger räknas ej", () => {
  assert.equal(workingDays("2026-11-16", "2026-11-22"), 5);
  assert.equal(plannedHours("2026-11-16", "2026-12-06", 50), 60);
  assert.equal(plannedHours("2026-11-16", "2026-11-20", 25), 10);
  assert.equal(plannedHours("2026-11-16", "2026-11-20", 100, {excludeDates:["2026-11-18"]}), 32);
});
test("valfri veckodag, ingen implicit planerad tid om fältet är tomt", () => {
  const row={"Vecka":"2026-V40","Dag":"","Vad jag skall göra":"Konstruktion","Varaktighet":"3 veckor","Insats":"50 %","Planerade timmar":"","Projektkod":"P-1"};
  assert.deepEqual(validateWeeklyRow(row), {week:"2026-V40",day:null,durationDays:21,effortPercent:50,plannedHours:null});
  assert.throws(() => validateWeeklyRow({...row,Vecka:"2026-V54"}));
});
