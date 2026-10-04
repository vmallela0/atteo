import { describe, expect, it } from "vitest";
import { LANG_NAMES, fromAcceptLanguage, matchLang, pickLang, tr } from "../src/i18n";
import { ZH_CN } from "../src/i18n.zh";
import { ZH_HANT } from "../src/i18n.zh-hant";
import { ES } from "../src/i18n.es";
import { JA } from "../src/i18n.ja";
import { KO } from "../src/i18n.ko";
import { HI } from "../src/i18n.hi";
import { boardPage, homePage } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";

describe("languages (#1646)", () => {
  it("picks ?lang=, then the saved pref, then the browser's Accept-Language, else English", () => {
    expect(pickLang(null, null, null)).toBe("en");
    expect(pickLang("auto", null, "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-Hans");
    expect(pickLang("en", null, "zh-CN")).toBe("en");
    expect(pickLang("zh-Hans", null, "en-US")).toBe("zh-Hans");
    expect(pickLang("en", "zh", "en-US")).toBe("zh-Hans");
    expect(pickLang("auto", "fr", "de-DE,fr;q=0.5")).toBe("en");
    expect(fromAcceptLanguage("fr-FR, zh-Hans-CN;q=0.7, en;q=0.5")).toBe("zh-Hans");
    expect(fromAcceptLanguage("en;q=0.9, zh;q=0.95")).toBe("zh-Hans");
    expect(matchLang("zh-TW")).toBe("zh-Hant");
    expect(matchLang("zh-Hant-HK")).toBe("zh-Hant");
    expect(pickLang("zh-Hant", null, "zh-CN")).toBe("zh-Hant");
    expect(pickLang("ja", null, "zh-TW")).toBe("ja");
    expect(matchLang("fr")).toBe(null);
  });

  it("translates by the English string, fills {placeholders}, and falls back to the English", () => {
    expect(tr("zh-Hans", "Boards")).toBe("看板");
    expect(tr("zh-Hans", "{n}m ago", { n: 5 })).toBe("5 分钟前");
    expect(tr("zh-Hans", "Not in the table")).toBe("Not in the table");
    expect(tr("zh-Hant", "Members & access")).toBe("成員與權限");
    expect(tr("zh-Hant", "Your agent")).toBe("你的智能體");
    expect(tr("en", "{name}'s agent", { name: "vedu" })).toBe("vedu's agent");
    expect(tr(undefined, "Boards")).toBe("Boards");
    expect(Object.keys(ZH_HANT).sort()).toEqual(Object.keys(ZH_CN).sort()); // the two tables cover the same strings
    for (const [k, v] of [...Object.entries(ZH_CN), ...Object.entries(ZH_HANT)]) {
      // Every {placeholder} in the English is kept in the Chinese.
      for (const ph of k.match(/\{\w+\}/g) ?? []) expect(v, k).toContain(ph);
      expect(v.trim(), k).not.toBe("");
    }
  });

  const info: BoardInfo = { id: "b_test1234", title: "支付 bug", created_by: "jxn", created_at: 0, entry_count: 1, last_seq: 1 };
  const entries: Entry[] = [{ seq: 1, ts: 1, author: "vedu", type: "question", text: "Can you check?", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent" }];
  const viewer = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang: "zh-Hans" as const };

  it("the board page in zh-Hans: html lang, the table for its scripts, Chinese chrome, people's words untouched, scripts compile", async () => {
    const res = boardPage(viewer, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0 }], entries, []);
    const html = await res.text();
    expect(res.headers.get("content-language")).toBe("zh-Hans");
    expect(res.headers.get("vary")).toContain("Accept-Language"); // caches keep each language apart
    expect(html).toContain('<html lang="zh-Hans">');
    expect(html).toContain("window.I18N={");
    for (const zh of ["对话", "发送", "看板信息", "回复", "问题"]) expect(html).toContain(zh);
    expect(html).toContain("Can you check?"); // a message is never translated
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
  });

  it("home in zh-Hans, and English stays English with no table", async () => {
    const zh = await homePage(viewer, [], []).text();
    for (const w of ["看板", "新建看板", "添加你的智能体"]) expect(zh).toContain(w);
    const en = await homePage({ ...viewer, lang: "en" }, [], []).text();
    expect(en).toContain('<html lang="en">');
    expect(en).not.toContain("window.I18N=");
    expect(en).toContain("New board");
  });
});

describe("languages step 2 (#1701): For you, Inbox, Approvals, People, welcome", () => {
  const zh = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang: "zh-Hans" as const };
  const compiles = async (res: Response) => {
    const html = await res.text();
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
    return html;
  };
  it("render in Chinese and their scripts compile", async () => {
    const { forYouPage, greetingFor, summaryLine, whoLabel } = await import("../src/forYou");
    const { inboxPage } = await import("../src/inbox");
    const { approvalsPage } = await import("../src/approvalsPage");
    const { peoplePage } = await import("../src/html");
    const { assistantWelcomePage } = await import("../src/welcome");
    expect(greetingFor(9, "zh-Hans")).toBe("早上好");
    expect(summaryLine(2, 1, "zh-Hans")).toBe("有 2 件事需要你。你的助手还完成了 1 件。");
    expect(whoLabel("sam", "agent", "jxn", "zh-Hans")).toBe("Sam 的助手");
    expect(whoLabel("sam", "agent", "jxn")).toBe("Sam's assistant"); // English by default, as before
    expect(await compiles(forYouPage(zh, [], { approvals: [], boards: [], mentions: [] }))).toContain("现在没有需要你处理的事");
    expect(await compiles(inboxPage(zh, [], []))).toContain("收件箱");
    expect(await compiles(approvalsPage(zh, [], [], {}))).toContain("审批");
    expect(await compiles(peoplePage(zh, [], { friends: [], incoming: [], outgoing: [], blocked: [] } as never))).toContain("联系人");
    expect(await compiles(assistantWelcomePage(zh, [], "https://atteo.example", []))).toContain("带上你的助手");
  });
});

describe("languages step 4 (#1786): Español, 日本語, 한국어, हिन्दी", () => {
  const tables = { es: ES, ja: JA, ko: KO, hi: HI };
  it("are matched from the browser and the saved pref, and the picker names each in its own words", () => {
    expect(matchLang("es-MX")).toBe("es");
    expect(matchLang("es")).toBe("es");
    expect(matchLang("ja-JP")).toBe("ja");
    expect(matchLang("ko-KR")).toBe("ko");
    expect(matchLang("hi-IN")).toBe("hi");
    expect(matchLang("eu")).toBe(null); // Basque is not Spanish
    expect(fromAcceptLanguage("fr-FR, ko;q=0.8, en;q=0.5")).toBe("ko");
    expect(pickLang("hi", null, "en-US")).toBe("hi");
    expect(pickLang("auto", null, "es-419,es;q=0.9")).toBe("es");
    expect(LANG_NAMES).toMatchObject({ es: "Español", ja: "日本語", ko: "한국어", hi: "हिन्दी" });
  });
  it("cover the same strings as 简体中文, keep every {placeholder} and <b>, and are never empty", () => {
    const keys = Object.keys(ZH_CN).sort();
    for (const [lang, t] of Object.entries(tables)) {
      expect(Object.keys(t).sort(), lang).toEqual(keys);
      for (const [k, v] of Object.entries(t)) {
        expect((v.match(/\{\w+\}/g) ?? []).sort(), `${lang}: ${k}`).toEqual((k.match(/\{\w+\}/g) ?? []).sort());
        expect((v.match(/<\/?b>/g) ?? []).length, `${lang}: ${k}`).toBe((k.match(/<\/?b>/g) ?? []).length);
        expect(v.trim(), `${lang}: ${k}`).not.toBe("");
      }
    }
    expect(tr("es", "{n}m ago", { n: 5 })).toMatch(/5/);
    expect(tr("ja", "Boards")).not.toBe("Boards");
  });
  it("the board page and home render in each, with scripts that compile", async () => {
    const info: BoardInfo = { id: "b_test1234", title: "pagos", created_by: "jxn", created_at: 0, entry_count: 1, last_seq: 1 };
    const entries: Entry[] = [{ seq: 1, ts: 1, author: "vedu", type: "question", text: "Can you check?", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent" }];
    for (const lang of ["es", "ja", "ko", "hi"] as const) {
      const viewer = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang };
      const res = boardPage(viewer, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0 }], entries, []);
      const html = await res.text();
      expect(res.headers.get("content-language")).toBe(lang);
      expect(html).toContain(`<html lang="${lang}">`);
      expect(html).toContain(tables[lang]["Send"]);
      expect(html).toContain("Can you check?");
      for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
      const home = await homePage(viewer, [], []).text();
      expect(home).toContain(tables[lang]["New board"]);
    }
  });
});
