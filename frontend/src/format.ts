const nfCache = new Map<string, Intl.NumberFormat>();
function nf(key: string, opts: Intl.NumberFormatOptions, locale = "en-US") {
  const k = locale + key;
  let f = nfCache.get(k);
  if (!f) { f = new Intl.NumberFormat(locale, opts); nfCache.set(k, f); }
  return f;
}

export const isNum = (v: any): v is number => typeof v === "number" && Number.isFinite(v);

export function money(v: any, currency = "USD", compact = false): string {
  if (!isNum(v)) return "-";
  const locale = currency === "INR" ? "en-IN" : "en-US";
  try {
    if (compact && Math.abs(v) >= 1e5) {
      if (currency === "INR") {
        const sym = "₹";
        if (Math.abs(v) >= 1e7) return `${v < 0 ? "-" : ""}${sym}${(Math.abs(v) / 1e7).toFixed(2)} Cr`;
        return `${v < 0 ? "-" : ""}${sym}${(Math.abs(v) / 1e5).toFixed(2)} L`;
      }
      return nf(`c-${currency}`, { style: "currency", currency, notation: "compact", maximumFractionDigits: 2 }, locale).format(v);
    }
    return nf(`m-${currency}`, { style: "currency", currency, maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }, locale).format(v);
  } catch {
    return num(v, 2);
  }
}

export function num(v: any, d = 2): string {
  if (!isNum(v)) return "-";
  if (Math.abs(v) < 0.5 * 10 ** -d) v = 0; // avoid "-0.00"
  return nf(`n${d}`, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

export function compact(v: any): string {
  if (!isNum(v)) return "-";
  return nf("cmp", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

export function pct(v: any, d = 2, signed = true): string {
  if (!isNum(v)) return "-";
  const s = signed && v > 0 ? "+" : "";
  return `${s}${num(v, d)}%`;
}

export const tone = (v: any) => (!isNum(v) || v === 0 ? "" : v > 0 ? "pos" : "neg");

export function date(ts: number | string, withTime = false): string {
  // Bar timestamps are exchange wall-clock times serialised without a zone: read them as UTC
  // (and render in UTC) so dates never shift with the viewer's timezone.
  const d = typeof ts === "number" ? new Date(ts * 1000)
    : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) || ts.length <= 10 ? ts : ts + "Z");
  if (isNaN(d.getTime())) return "-";
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" };
  if (withTime) { opts.hour = "2-digit"; opts.minute = "2-digit"; }
  return d.toLocaleDateString("en-GB", opts);
}

export function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

export function relTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const label = (k: string) =>
  k.replace(/_pct$/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function downloadCSV(name: string, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadJSON(name: string, data: any) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
