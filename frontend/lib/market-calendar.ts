/**
 * NSE trading calendar: weekends and exchange holidays (equity segment).
 *
 * Mirrors backend/app/services/daily_signal_engine/market_calendar.py, and a
 * backend test checks the two lists match. Add a year when NSE publishes its
 * circular (usually in December).
 */

export const NSE_HOLIDAYS: Record<string, string> = {
  // 2026, NSE equity segment (weekday closures only)
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas',
};

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

export function isTradingDay(iso: string) {
  const day = toDate(iso).getUTCDay();
  return day !== 0 && day !== 6 && !(iso in NSE_HOLIDAYS);
}

export function nextTradingDay(iso: string) {
  let next = addDays(iso, 1);
  while (!isTradingDay(next)) next = addDays(next, 1);
  return next;
}

/** The `sessions`-th trading session counting `start` as the first. */
export function sessionAfter(start: string, sessions: number) {
  let day = isTradingDay(start) ? start : nextTradingDay(start);
  for (let i = 1; i < sessions; i++) day = nextTradingDay(day);
  return day;
}

/** Why a weekday between two sessions is closed, for showing skipped holidays. */
export function holidaysBetween(startIso: string, endIso: string) {
  return Object.entries(NSE_HOLIDAYS)
    .filter(([day]) => day > startIso && day < endIso)
    .map(([day, name]) => ({ day, name }));
}
