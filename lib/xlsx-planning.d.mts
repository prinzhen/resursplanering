export function createPlanningWorkbook(type: "weekly" | "project", rows?: Array<Record<string, string | number | null | undefined>>): Uint8Array;
export function parsePlanningWorkbook(buffer: ArrayBuffer, type: "weekly" | "project"): Array<Record<string, string | number | boolean>>;
