// REST calls used by the chart workspace.
import type { Bars, Interval } from "./types";

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: init?.body ? { "Content-Type": "application/json" } : undefined });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}
const qs = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export interface Dataset { name: string; rows: number; start: string; end: string; last_close: number }
export interface LayoutMeta { id: string; name: string; updated: string; symbol?: string }

export const chartApi = {
  bars: (symbol: string, interval: Interval) => get<Bars>(`/api/chart/bars?${qs({ symbol, interval })}`),
  uploads: () => get<Dataset[]>("/api/data/uploads"),
  upload: async (file: File) => {
    const fd = new FormData(); fd.append("file", file);
    const r = await fetch("/api/data/upload", { method: "POST", body: fd });
    if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); m = j.detail || m; } catch { /* not json */ } throw new Error(m); }
    return r.json() as Promise<Dataset>;
  },
  deleteUpload: (name: string) => get(`/api/data/uploads/${encodeURIComponent(name)}`, { method: "DELETE" }),
  layouts: () => get<LayoutMeta[]>("/api/layouts"),
  layout: (id: string) => get<LayoutMeta & { state: any }>(`/api/layouts/${encodeURIComponent(id)}`),
  saveLayout: (name: string, state: any) => get<LayoutMeta>("/api/layouts", { method: "POST", body: JSON.stringify({ name, state }) }),
  deleteLayout: (id: string) => get(`/api/layouts/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
