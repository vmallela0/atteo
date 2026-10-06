// The web's type (design language v1, jxn #4682): Onest for the controls, STIX Two Text (variable) for the brand and titles,
// Courier Prime for what agents say. Enriqueta and Schoolbell stay for the landing page until it moves over. Google's
// own woff2 subsets (SIL Open Font License, src/fonts/OFL-*.txt), served by this Worker at /fonts/<file>?v=FONT_V so
// no page asks Google for anything (opus-d, #2515). Pure data: ui.ts builds the @font-face rules from FONT_FACES; fonts.ts serves the files.

/** Bump when a file changes: the URLs carry it, and they are cached for good. */
export const FONT_V = "1";

export interface FontFace { family: string; weight: string; file: string; range: string }

export const FONT_FACES: FontFace[] = [
  { family: "Courier Prime", weight: "400", file: "courier-prime-latin-ext-400.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Courier Prime", weight: "400", file: "courier-prime-latin-400.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "Enriqueta", weight: "400", file: "enriqueta-latin-ext-400.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Enriqueta", weight: "400", file: "enriqueta-latin-400.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "Enriqueta", weight: "600", file: "enriqueta-latin-ext-600.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Enriqueta", weight: "600", file: "enriqueta-latin-600.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "Onest", weight: "400 600", file: "onest-cyrillic-ext.woff2", range: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" },
  { family: "Onest", weight: "400 600", file: "onest-cyrillic.woff2", range: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" },
  { family: "Onest", weight: "400 600", file: "onest-vietnamese.woff2", range: "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB" },
  { family: "Onest", weight: "400 600", file: "onest-latin-ext.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "Onest", weight: "400 600", file: "onest-latin.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "STIX Two Text", weight: "400 700", file: "stix-two-text-latin-ext.woff2", range: "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF" },
  { family: "STIX Two Text", weight: "400 700", file: "stix-two-text-latin.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
  { family: "Schoolbell", weight: "400", file: "schoolbell-latin.woff2", range: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" },
];

const faceCss = (f: FontFace) => `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/fonts/${f.file}?v=${FONT_V}) format("woff2");unicode-range:${f.range}}`;

/** The @font-face rules, for a page's <style>. font-display: swap, so text shows at once in a fallback. */
export const FONT_CSS = FONT_FACES.map(faceCss).join("\n");

/** The app's own faces (jxn #4682): Onest, STIX Two Text and Courier Prime; Enriqueta and Schoolbell are the landing's. */
export const APP_FONT_CSS = FONT_FACES.filter((f) => f.family !== "Enriqueta" && f.family !== "Schoolbell").map(faceCss).join("\n");

