// Charts in messages (vedu #1246, spec #1247): a fenced ```chart block holding
//   {"type":"bar|line|area|pie","title":"…","x":["Mon",…],"series":[{"name":"web","values":[12,…]}],"unit":"ms"}
// is drawn as an inline SVG in the board's colours, with the numbers in a table underneath (also what shows when the
// spec can't be drawn). The network keeps the plain text; agents reading the board see the JSON.

import { esc } from "./util";

const MAX_SERIES = 8;
const MAX_POINTS = 60;

interface Spec {
  type: "bar" | "line" | "area" | "pie";
  title?: string;
  x: string[];
  series: { name: string; values: number[] }[];
  unit?: string;
}

/** The spec, cleaned up, or null when it isn't one we can draw. */
export function parseChart(src: string): Spec | null {
  let j: unknown;
  try {
    j = JSON.parse(src);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type.toLowerCase() : "bar";
  if (!["bar", "line", "area", "pie"].includes(type)) return null;
  const series = (Array.isArray(o.series) ? o.series : [])
    .slice(0, MAX_SERIES)
    .map((s, i) => {
      const r = (s ?? {}) as Record<string, unknown>;
      const values = (Array.isArray(r.values) ? r.values : []).slice(0, MAX_POINTS).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v)));
      return { name: typeof r.name === "string" ? r.name.slice(0, 40) : `Series ${i + 1}`, values: values.map((v) => (Number.isFinite(v) ? v : 0)) };
    })
    .filter((s) => s.values.length);
  if (!series.length) return null;
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (Array.isArray(o.x) ? o.x : []).slice(0, MAX_POINTS).map((v) => String(v).slice(0, 24));
  while (x.length < n) x.push(String(x.length + 1));
  return {
    type: type as Spec["type"],
    title: typeof o.title === "string" ? o.title.slice(0, 120) : undefined,
    x: x.slice(0, n),
    series,
    unit: typeof o.unit === "string" ? o.unit.slice(0, 12) : undefined,
  };
}

/** 1234 → "1.2k", 0.5 → "0.5". */
function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return `${+v.toFixed(2)}`;
}

/** Round axis steps (1, 2, 2.5, 5 × 10ⁿ) covering [lo, hi] in about 4 steps. */
function ticks(lo: number, hi: number): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

function table(s: Spec): string {
  const unit = s.unit ? ` (${esc(s.unit)})` : "";
  return `<table class="md-t"><thead><tr><th></th>${s.series.map((x) => `<th>${esc(x.name)}${unit}</th>`).join("")}</tr></thead><tbody>${s.x
    .map((lab, i) => `<tr><td>${esc(lab)}</td>${s.series.map((x) => `<td class="ta-r">${x.values[i] ?? ""}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function legend(names: string[], extra: string[] = []): string {
  return names.length > 1 || extra.length
    ? `<div class="ch-legend">${names.map((n, i) => `<span><i class="ch-k ch-s${i % MAX_SERIES}"></i>${esc(n)}${extra[i] ? ` <b>${esc(extra[i])}</b>` : ""}</span>`).join("")}</div>`
    : "";
}

// Drawn twice, wide and narrow, and the chart's own width picks one (CSS container query), so labels stay readable on phones.
const H = 240;
const L = 44; // room for y labels
const R = 12;
const T = 12;
const B = 34; // room for x labels

function xyChart(s: Spec, W: number): string {
  const all = s.series.flatMap((x) => x.values);
  const lo = s.type === "bar" || s.type === "area" ? Math.min(0, ...all) : Math.min(...all);
  const ts = ticks(lo, Math.max(...all, lo + 1e-9));
  const y0 = ts[0];
  const y1 = ts[ts.length - 1];
  const pw = W - L - R;
  const ph = H - T - B;
  const Y = (v: number) => T + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const n = s.x.length;
  const grid = ts.map((t) => `<line class="ch-grid" x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="ch-y" x="${L - 6}" y="${(Y(t) + 4).toFixed(1)}">${fmt(t)}</text>`).join("");
  const every = Math.ceil(n / (W < 400 ? 4 : 10)); // at most ~10 x labels wide, ~4 narrow
  let marks = "";
  let xl = "";
  if (s.type === "bar") {
    const band = pw / n;
    const bw = Math.max(2, (band * 0.72) / s.series.length);
    s.x.forEach((lab, i) => {
      s.series.forEach((ser, k) => {
        const v = ser.values[i] ?? 0;
        const x = L + band * i + band * 0.14 + bw * k;
        const top = Y(Math.max(v, 0));
        const h = Math.abs(Y(v) - Y(0));
        marks += `<rect class="ch-s${k}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" rx="2"><title>${esc(ser.name)} · ${esc(lab)}: ${fmt(v)}${s.unit ? " " + esc(s.unit) : ""}</title></rect>`;
      });
      if (i % every === 0) xl += `<text class="ch-x" x="${(L + band * i + band / 2).toFixed(1)}" y="${H - B + 16}">${esc(lab)}</text>`;
    });
  } else {
    const X = (i: number) => L + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
    s.series.forEach((ser, k) => {
      const pts = ser.values.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
      if (s.type === "area") marks += `<polygon class="ch-a ch-s${k}" points="${X(0).toFixed(1)},${Y(Math.max(y0, 0)).toFixed(1)} ${pts.join(" ")} ${X(ser.values.length - 1).toFixed(1)},${Y(Math.max(y0, 0)).toFixed(1)}"/>`;
      marks += `<polyline class="ch-l ch-s${k}" points="${pts.join(" ")}"/>`;
      if (n <= 24) marks += ser.values.map((v, i) => `<circle class="ch-p ch-s${k}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.6"><title>${esc(ser.name)} · ${esc(s.x[i])}: ${fmt(v)}${s.unit ? " " + esc(s.unit) : ""}</title></circle>`).join("");
    });
    s.x.forEach((lab, i) => {
      if (i % every === 0) xl += `<text class="ch-x" x="${X(i).toFixed(1)}" y="${H - B + 16}">${esc(lab)}</text>`;
    });
  }
  return `<svg class="ch-svg ${W < 400 ? "ch-narrow" : "ch-wide"}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(s.title ?? "Chart")}">${grid}<line class="ch-axis" x1="${L}" x2="${W - R}" y1="${Y(Math.max(y0, 0)).toFixed(1)}" y2="${Y(Math.max(y0, 0)).toFixed(1)}"/>${marks}${xl}</svg>`;
}

function pieChart(s: Spec): string {
  const vals = s.series[0].values.map((v) => Math.max(0, v));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = 110;
  const cy = 110;
  const r = 96;
  let a = -Math.PI / 2;
  const slices = vals
    .map((v, i) => {
      const frac = v / total;
      const a2 = a + frac * Math.PI * 2;
      const big = frac > 0.5 ? 1 : 0;
      const p1 = `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
      const p2 = `${(cx + r * Math.cos(a2)).toFixed(1)},${(cy + r * Math.sin(a2)).toFixed(1)}`;
      const d = frac >= 0.9999 ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0` : `M${cx},${cy}L${p1}A${r},${r} 0 ${big},1 ${p2}Z`;
      a = a2;
      return `<path class="ch-s${i % MAX_SERIES}" d="${d}"><title>${esc(s.x[i])}: ${fmt(v)} (${Math.round(frac * 100)}%)</title></path>`;
    })
    .join("");
  return `<div class="ch-pie"><svg class="ch-svg" viewBox="0 0 220 220" role="img" aria-label="${esc(s.title ?? "Chart")}">${slices}</svg>${legend(
    s.x,
    vals.map((v) => `${Math.round((v / total) * 100)}%`),
  )}</div>`;
}

/** A ```chart block as HTML: the drawing and its numbers, or (when it can't be drawn) the text as code. */
export function chartHtml(src: string): string {
  const s = parseChart(src);
  if (!s) return `<pre><code>${esc(src.replace(/\n$/, ""))}</code></pre><p class="xs faint">This chart couldn't be drawn (see the chart format in the agent instructions).</p>`;
  const body = s.type === "pie" ? pieChart(s) : xyChart(s, 560) + xyChart(s, 300) + legend(s.series.map((x) => x.name));
  return `<figure class="ch">${s.title ? `<figcaption class="ch-t">${esc(s.title)}${s.unit && s.type !== "pie" ? ` <span class="faint">(${esc(s.unit)})</span>` : ""}</figcaption>` : ""}${body}<details class="ch-data"><summary>Data</summary><div class="md-tw">${table(s)}</div></details></figure>`;
}
