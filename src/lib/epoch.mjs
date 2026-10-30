/**
 * Epoch timestamps for the Time panel: read one (or a date) from pasted text,
 * and show it in any time zone. ES module so the Node tests can import it.
 */

// Chromium's ICU still lists these zones under their old names. Intl accepts
// the current names too, so the list shows and searches those instead.
const RENAMED = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

export const currentZoneName = (zone) => RENAMED[zone] || zone;

export function isZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The machine's own time zone. */
export function systemZone() {
  return currentZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
}

/** "GMT+05:30", or "GMT" for no offset, at the given moment. */
export function zoneOffset(zone, ms = Date.now()) {
  return part(new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }), ms, 'timeZoneName');
}

let zoneList = null;

/**
 * Every time zone, UTC first, each with what search matches on: its name,
 * its long name ("India Standard Time") and its offset now.
 */
export function timeZones() {
  if (zoneList) return zoneList;
  const names = [...new Set(Intl.supportedValuesOf('timeZone').map(currentZoneName))].sort();
  zoneList = ['UTC', ...names.filter((z) => z !== 'UTC')].map((id) => {
    const longName = part(new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'long' }), Date.now(), 'timeZoneName');
    const offset = zoneOffset(id);
    return { id, longName, offset, search: `${id} ${id.replace(/_/g, ' ')} ${longName} ${offset}`.toLowerCase() };
  });
  return zoneList;
}

/** Zones whose name, long name or offset contain every word of the query. */
export function searchZones(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return timeZones().filter((z) => words.every((w) => z.search.includes(w)));
}

/**
 * Read a timestamp out of pasted text: an epoch in seconds, milliseconds,
 * microseconds or nanoseconds (told apart by size), or a date string.
 * Quotes, commas and underscores are ignored, so `"1,695,391,932,115",` works.
 * Returns { ms, unit } or { error }, or null for empty text.
 */
export function parseTimestamp(text) {
  const raw = String(text ?? '').trim().replace(/^["']|["'],?$|,$/g, '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[,_\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(digits)) {
    const n = Number(digits);
    const size = Math.abs(n);
    // A seconds count below 1e11 reaches the year 5138; anything bigger is a finer unit.
    const [unit, ms] =
      size < 1e11 ? ['seconds', n * 1000]
      : size < 1e14 ? ['milliseconds', n]
      : size < 1e17 ? ['microseconds', n / 1e3]
      : ['nanoseconds', n / 1e6];
    if (Number.isNaN(new Date(ms).getTime())) return { error: 'That is too far in the past or future to show' };
    return { ms, unit };
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { error: 'Not an epoch number or a date' };
  return { ms, unit: 'date' };
}

/** The moment shown every way the panel offers, in `zone`. */
export function describeMoment(ms, zone, now = Date.now()) {
  const fmt = (options) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...options });
  const parts = Object.fromEntries(
    fmt({
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
      hourCycle: 'h23', timeZoneName: 'longOffset',
    }).formatToParts(ms).map((p) => [p.type, p.value])
  );
  const offset = parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '');
  return {
    local: `${fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(ms)}, ` +
      `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond} ${parts.timeZoneName}`,
    iso: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`,
    utc: new Date(ms).toISOString(),
    relative: relativeTime(ms, now),
    millis: String(Math.trunc(ms)),
    seconds: String(Math.trunc(ms / 1000)),
  };
}

const UNITS = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
  ['second', 1e3],
];

/** "3 hours ago", "in 2 days". */
export function relativeTime(ms, now = Date.now()) {
  const diff = ms - now;
  const [unit, size] = UNITS.find(([, size]) => Math.abs(diff) >= size) || UNITS.at(-1);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(diff / size), unit);
}

function part(format, ms, type) {
  return format.formatToParts(ms).find((p) => p.type === type)?.value ?? '';
}
