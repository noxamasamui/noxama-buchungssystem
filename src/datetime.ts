/** Erzeuge eine lokale Date-Uhrzeit ohne Timezone-Überraschungen */
export function localDate(y: number, m1: number, d: number, hh = 0, mm = 0, ss = 0) {
  return new Date(y, m1 - 1, d, hh, mm, ss, 0);
}

/** "YYYY-MM-DD" -> {y,m,d} */
export function splitYmd(ymd: string) {
  const [y, m, d] = ymd.split("-").map(n => Number(n));
  return { y, m, d };
}

/** "YYYY-MM-DD" + "HH:MM" -> Date (lokal) */
export function localDateFrom(ymd: string, hhmm: string) {
  const { y, m, d } = splitYmd(ymd);
  const [hh, mm] = hhmm.split(":").map(n => Number(n));
  return localDate(y, m, d, hh, mm, 0);
}
