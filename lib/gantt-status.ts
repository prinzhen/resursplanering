/** Shared Gantt state and color rules; used by both the interactive chart and print view. */
export type GanttStatusItem = {
  color: string;
  completed?: boolean;
  completedAt?: string;
  status?: string;
};

export function ganttState(item: GanttStatusItem): string {
  if (item.completed || item.completedAt || item.status === "Klar") return "Klar";
  if (item.status === "Fryst" || item.status === "Pausad") return item.status;
  if (item.status === "Pågår") return "Pågående";
  return item.status || "Planerad";
}

export function ganttColor(item: GanttStatusItem): string {
  const status = ganttState(item);
  if (status === "Klar") return `color-mix(in srgb, ${item.color} 34%, white)`;
  if (status === "Fryst" || status === "Pausad") return `color-mix(in srgb, ${item.color} 48%, white)`;
  return item.color;
}
