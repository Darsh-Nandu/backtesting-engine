// Timezone support. Lightweight-charts renders timestamps as UTC, so to display another
// zone each bar time is shifted by that zone's UTC offset at that instant.

export const TIMEZONES: { id: string; label: string }[] = [
  { id: "UTC", label: "UTC" },
  { id: "exchange", label: "Exchange" },
  { id: "local", label: "Local (browser)" },
  { id: "America/New_York", label: "New York" },
  { id: "America/Chicago", label: "Chicago" },
  { id: "America/Los_Angeles", label: "Los Angeles" },
  { id: "Europe/London", label: "London" },
  { id: "Europe/Berlin", label: "Frankfurt" },
  { id: "Asia/Kolkata", label: "Kolkata" },
  { id: "Asia/Singapore", label: "Singapore" },
  { id: "Asia/Hong_Kong", label: "Hong Kong" },
  { id: "Asia/Tokyo", label: "Tokyo" },
  { id: "Australia/Sydney", label: "Sydney" },
];

export function resolveTz(id: string, exchangeTz: string): string {
  if (id === "exchange") return exchangeTz || "UTC";
  if (id === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return id;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  return f;
}

/** UTC offset in seconds of `tz` at epoch second `t`. */
export function tzOffset(t: number, tz: string): number {
  if (tz === "UTC") return 0;
  const parts = fmt(tz).formatToParts(new Date(t * 1000));
  const g = (k: string) => +(parts.find((p) => p.type === k)?.value || 0);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) / 1000;
  return Math.round((asUtc - t) / 60) * 60;
}

/** A memoised shift function (offsets only change at DST boundaries, so cache per hour). */
export function makeShift(tz: string): (t: number) => number {
  if (tz === "UTC") return (t) => t;
  const cache = new Map<number, number>();
  return (t) => {
    const k = Math.floor(t / 3600);
    let o = cache.get(k);
    if (o === undefined) { o = tzOffset(t, tz); cache.set(k, o); }
    return t + o;
  };
}

export function offsetLabel(tz: string, t = Date.now() / 1000) {
  const o = tzOffset(t, tz) / 60;
  if (!o) return "UTC";
  const s = o > 0 ? "+" : "-", a = Math.abs(o);
  return `UTC${s}${Math.floor(a / 60)}${a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""}`;
}
