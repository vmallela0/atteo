// The mark (jxn's atteo_design.pdf, page 2; vedu's agent #4701): three curves through three nodes on a rounded tile
// (radius 22.5% of its size). The drawing is the PDF's, verbatim; only its two colours follow the theme: paper tile and
// ink lines in light, swapped in dark. Shared by the app (ui.ts) and the landing page.

/** The three curves, in a 100×100 box; they run past the tile and are cut by its rounded edge. */
export const MARK_PATH =
  "M21 -8C21.5 -2.2 23.2 12.8 24 27C24.8 41.2 26.7 63.5 26 77C25.3 90.5 21 102.8 20 108M-8 24C-2.7 24.5 12.5 24.5 24 27C35.5 29.5 47 32.2 61 39C75 45.8 100.2 63.2 108 68M86 -8C81.8 -0.2 71 24.8 61 39C51 53.2 35.8 65.8 26 77C16.2 88.2 6 101.2 2 106";
const NODES: [number, number][] = [[24, 27], [61, 39], [26, 77]];

/** A standalone SVG file (favicon, app icons): fixed colours, its own clip (one per file, so the id can't collide).
 *  `bold` is the small-size cut: thicker lines and bigger nodes, so 16px tabs still read three lines and three dots. */
export function markFile(tile: string, ink: string, edge: string | null = null, bold = false): string {
  const w = bold ? 7 : 4.6, r = bold ? 7 : 4.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><clipPath id="t"><rect width="100" height="100" rx="22.5"/></clipPath></defs><rect width="100" height="100" rx="22.5" fill="${tile}"/><g clip-path="url(#t)"><path d="${MARK_PATH}" fill="none" stroke="${ink}" stroke-width="${w}" stroke-linecap="round"/><g fill="${ink}">${NODES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join("")}</g>${edge ? `<rect width="100" height="100" rx="22.5" fill="none" stroke="${edge}" stroke-width="3"/>` : ""}</g></svg>`;
}

/** The mark inline (jxn's atteo_design.pdf, page 1; vedu's agent #4714): no tile, in the text's colour (currentColor), the
 *  PDF's drawing verbatim. Its curves are cut by the rounded square, so each copy needs its own clipPath id: a counter
 *  keeps them apart however many a page holds. */
let clipN = 0;
export function markInline(px: number, cls: string): string {
  const id = `mkc${(clipN = (clipN + 1) % 1e9).toString(36)}`;
  return `<svg class="${cls}" width="${px}" height="${px}" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="${id}"><rect width="100" height="100" rx="22.5"/></clipPath></defs><g clip-path="url(#${id})"><path d="${MARK_PATH}" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round"/><g fill="currentColor">${NODES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4.8"/>`).join("")}</g></g></svg>`;
}
