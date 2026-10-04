// Interface languages (jxn #1645, plan #1646). One table per language, keyed by the English string as written in the
// code, so English needs no table and a missing translation shows the English. Only the interface is translated:
// what people and agents write never is. Page scripts get the same table (window.I18N) and the same tr().
//
// The language: ?lang= on the URL (an override), else the person's display prefs (lang, set in Account → Display,
// shared with the app), else the browser's Accept-Language; English when none of them names one we have.

import { ZH_CN } from "./i18n.zh";
import { ZH_HANT } from "./i18n.zh-hant";
import { ES } from "./i18n.es";
import { JA } from "./i18n.ja";
import { KO } from "./i18n.ko";
import { HI } from "./i18n.hi";

export type Lang = "en" | "zh-Hans" | "zh-Hant" | "es" | "ja" | "ko" | "hi";
export const LANGS: readonly Lang[] = ["en", "zh-Hans", "zh-Hant", "es", "ja", "ko", "hi"];
/** Each language in its own words, for the picker. */
export const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  es: "Español",
  ja: "日本語",
  ko: "한국어",
  hi: "हिन्दी",
};

const TABLES: Record<Lang, Record<string, string>> = { en: {}, "zh-Hans": ZH_CN, "zh-Hant": ZH_HANT, es: ES, ja: JA, ko: KO, hi: HI };

/** `s` in `lang`, with {name} placeholders filled from `vars`. */
export function tr(lang: Lang | null | undefined, s: string, vars?: Record<string, string | number>): string {
  let out = (lang && TABLES[lang]?.[s]) || s;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** A supported language from a tag like "zh", "zh-CN", "zh-Hans-CN", "zh-TW" or "en-GB"; null if we don't have it. */
export function matchLang(tag: string | null | undefined): Lang | null {
  const t = (tag ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("zh-hant") || t.startsWith("zh-tw") || t.startsWith("zh-hk") || t.startsWith("zh-mo")) return "zh-Hant";
  if (t === "zh" || t.startsWith("zh-cn") || t.startsWith("zh-hans") || t.startsWith("zh-sg")) return "zh-Hans";
  if (t === "en" || t.startsWith("en-")) return "en";
  for (const l of ["es", "ja", "ko", "hi"] as const) if (t === l || t.startsWith(`${l}-`)) return l;
  return null;
}

/** The first language in an Accept-Language header that we have, by its q order. */
export function fromAcceptLanguage(header: string | null | undefined): Lang | null {
  const tags = (header ?? "")
    .split(",")
    .map((p, i) => {
      const [tag, ...rest] = p.trim().split(";");
      const q = Number(rest.find((x) => x.trim().startsWith("q="))?.trim().slice(2) ?? "1");
      return { tag, q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const t of tags) {
    const m = matchLang(t.tag);
    if (m) return m;
  }
  return null;
}

/** pref: the saved display lang ("auto", "en", "zh-Hans"); query: ?lang=; header: Accept-Language. */
export function pickLang(pref: string | null | undefined, query: string | null | undefined, header: string | null | undefined): Lang {
  return matchLang(query) ?? (pref && pref !== "auto" ? matchLang(pref) : null) ?? fromAcceptLanguage(header) ?? "en";
}

/** The table a page script needs (inline it as window.I18N), JSON-safe inside <script>. Empty for English. */
export function clientTable(lang: Lang | null | undefined): string {
  return JSON.stringify(lang ? TABLES[lang] : {}).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const unescapeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fixed markup written in the code (dialogs and buttons shared by every page): its text nodes and its title, aria-label
 *  and placeholder attributes translated where the whole string is in the table. Never for anything people wrote. */
export function localize(lang: Lang | null | undefined, html: string): string {
  const t = lang ? TABLES[lang] : undefined;
  if (!t || !Object.keys(t).length) return html;
  return html
    .replace(/>([^<>]*[A-Za-z][^<>]*)</g, (m, x: string) => {
      const k = x.trim();
      const v = t[unescapeHtml(k)];
      return v ? `>${x.replace(k, escapeHtml(v))}<` : m;
    })
    .replace(/\b(title|aria-label|placeholder)="([^"]*)"/g, (m, n: string, x: string) => {
      const v = t[unescapeHtml(x)];
      return v ? `${n}="${escapeHtml(v)}"` : m;
    });
}
