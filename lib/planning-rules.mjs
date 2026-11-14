/**
 * Gemensamma regler för projekt- och veckoplanering.
 * Ingen koppling till databas, användare eller importformat.
 */
export const HOURS_PER_DAY = 8;
export const HOURS_PER_WEEK = 40;
export const WORKDAYS_PER_WEEK = 5;

export const WEEKLY_HEADERS = Object.freeze([
  "Vecka", "Dag", "Vad jag skall göra", "Varaktighet",
  "Insats", "Typ av arbete", "Planerade timmar", "Status",
  "Prioritet", "Klart senast", "Projektkod", "Projekt/verksamhet",
  "Först planerad", "Kommentar/behov", "Orsak om flyttad", "Aktivitets-ID",
]);

export const PROJECT_HEADERS = Object.freeze([
  "Projektkod", "Projekt/verksamhet", "Aktivitets-ID", "Aktivitet",
  "Beskrivning", "Startdatum", "Slutdatum", "Varaktighet",
  "Planerade timmar", "Insats", "Ansvarig", "Projektledare",
  "Status", "Prioritet", "Föregående aktivitet",
  "Klart senast", "Typ av arbete", "Kommentar",
]);

const DAY_NAMES = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
const MS_PER_DAY = 86400000;

export function parseISODate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    throw new Error("Datum måste anges som ÅÅÅÅ-MM-DD.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error("Ogiltigt kalenderdatum: " + value);
  }
  return date;
}

function isoDay(date) {
  return (date.getUTCDay() + 6) % 7;
}

/** Veckoår och veckonummer enligt ISO 8601. */
export function isoWeek(value) {
  const date = typeof value === "string" ? parseISODate(value) : new Date(value.getTime());
  date.setUTCDate(date.getUTCDate() + 3 - isoDay(date));
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY));
  return `${year}-V${String(week).padStart(2, "0")}`;
}

export function weekStart(value) {
  if (typeof value !== "string" || !/^\\d{4}-V\\d{2}$/.test(value)) {
    throw new Error("Vecka måste anges som ÅÅÅÅ-VNN.");
  }
  const [year, week] = value.split("-V").map(Number);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - isoDay(jan4) + (week - 1) * 7);
  if (isoWeek(jan4) !== value) throw new Error("Ogiltigt ISO-veckonummer: " + value);
  return jan4;
}

export function weekDayDate(week, day) {
  const normalized = String(day ?? "").trim().toLowerCase();
  const index = DAY_NAMES.findIndex(name => name.toLowerCase() === normalized);
  if (index < 0) throw new Error("Ogiltig veckodag: " + day);
  const date = weekStart(week);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
}

/** Varaktighet avser kalenderdagar; arbetstid räknas separat. */
export function parseDuration(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const match = /^\\s*(\\d+)\\s*(dag|dagar|dygn|vecka|veckor)\\s*$/i.exec(String(value));
  if (!match || Number(match[1]) <= 0) throw new Error("Varaktighet ska anges som exempelvis 3 dagar eller 2 veckor.");
  return Number(match[1]) * (match[2].toLowerCase().startsWith("veck") ? 7 : 1);
}

export function formatDuration(calendarDays) {
  if (!Number.isInteger(calendarDays) || calendarDays <= 0) throw new Error("Varaktighet måste vara ett positivt heltal dagar.");
  if (calendarDays <= 7) return `${calendarDays} ${calendarDays === 1 ? "dag" : "dagar"}`;
  const weeks = Math.floor(calendarDays / 7);
  const days = calendarDays % 7;
  return `${weeks} ${weeks === 1 ? "vecka" : "veckor"}${days ? ` ${days} ${days === 1 ? "dag" : "dagar"}` : ""}`;
}

/** Inkluderar båda datumen. Helgdagar kan senare skickas via excludeDates. */
export function workingDays(start, end, excludeDates = []) {
  const first = parseISODate(start);
  const last = parseISODate(end);
  if (last < first) throw new Error("Slutdatum får inte ligga före startdatum.");
  const excluded = new Set(excludeDates);
  let count = 0;
  for (let ms = first.getTime(); ms <= last.getTime(); ms += MS_PER_DAY) {
    const date = new Date(ms);
    if (isoDay(date) < WORKDAYS_PER_WEEK && !excluded.has(date.toISOString().slice(0, 10))) count++;
  }
  return count;
}

export function plannedHours(start, end, effortPercent, options = {}) {
  if (typeof effortPercent !== "number" || !Number.isFinite(effortPercent) || effortPercent < 0 || effortPercent > 100) {
    throw new Error("Insats måste ligga mellan 0 och 100 procent.");
  }
  const { excludeDates = [], hoursPerDay = HOURS_PER_DAY, capacityPercent = 100 } = options;
  if (hoursPerDay <= 0 || capacityPercent < 0 || capacityPercent > 100) throw new Error("Ogiltig arbetskapacitet.");
  return Math.round(workingDays(start, end, excludeDates) * hoursPerDay * effortPercent / 100 * capacityPercent / 100 * 100) / 100;
}

export function validateWeeklyRow(row) {
  if (!row || typeof row !== "object") throw new Error("Veckoraden saknas.");
  const week = String(row["Vecka"] ?? "").trim();
  weekStart(week);
  const day = String(row["Dag"] ?? "").trim();
  if (day) weekDayDate(week, day);
  const durationDays = parseDuration(row["Varaktighet"]);
  const effort = Number(String(row["Insats"] ?? "").replace("%", "").replace(",", "."));
  if (!Number.isFinite(effort) || effort < 0 || effort > 100) throw new Error("Insats måste ligga mellan 0 och 100 %.");
  const hoursText = String(row["Planerade timmar"] ?? "").replace(",", ".").trim();
  const hours = hoursText === "" ? null : Number(hoursText);
  if (hours !== null && (!Number.isFinite(hours) || hours < 0)) throw new Error("Planerade timmar måste vara ett positivt tal eller noll.");
  if (!String(row["Vad jag skall göra"] ?? "").trim()) throw new Error("Aktivitetens namn saknas.");
  if (!String(row["Projektkod"] ?? "").trim()) throw new Error("Projektkod saknas.");
  return { week, day: day || null, durationDays, effortPercent: effort, plannedHours: hours };
}
