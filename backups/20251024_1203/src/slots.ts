import { addMinutes } from "date-fns";

/** Dauerregeln: Mittag 90, Abend 150 Minuten */
export type SlotRule = { lunchEndHour: number; lunchMinutes: number; dinnerMinutes: number; };
export const defaultRule: SlotRule = { lunchEndHour: 16, lunchMinutes: 90, dinnerMinutes: 150 };

/** Dauer pro Startzeit */
export function slotDuration(_dateStr: string, timeStr: string, rule = defaultRule): number {
  const h = Number((timeStr || "00:00").split(":")[0] || "0");
  return h < rule.lunchEndHour ? rule.lunchMinutes : rule.dinnerMinutes;
}

/** 15-Minuten Raster zwischen open und close (keine Sonntagsprüfung hier) */
export function generateSlots(dateStr: string, openHour: number, closeHour: number): string[] {
  const open = new Date(`${dateStr}T${String(openHour).padStart(2,"0")}:00:00`);
  const close = new Date(`${dateStr}T${String(closeHour).padStart(2,"0")}:00:00`);
  if (isNaN(open.getTime()) || isNaN(close.getTime()) || close <= open) return [];
  const out: string[] = [];
  let t = new Date(open);
  while (t < close) {
    out.push(`${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}`);
    t = addMinutes(t, 15);
  }
  return out;
}
