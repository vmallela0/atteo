import { describe, expect, it } from "vitest";
import { LANG_NAMES, dirOf, fromAcceptLanguage, matchLang, pickLang, tr } from "../src/i18n";
import { ZH_CN } from "../src/i18n.zh";
import { ZH_HANT } from "../src/i18n.zh-hant";
import { ES } from "../src/i18n.es";
import { FR } from "../src/i18n.fr";
import { JA } from "../src/i18n.ja";
import { KO } from "../src/i18n.ko";
import { HI } from "../src/i18n.hi";
import { PT } from "../src/i18n.pt";
import { DE } from "../src/i18n.de";
import { RU } from "../src/i18n.ru";
import { ID } from "../src/i18n.id";
import { TR } from "../src/i18n.tr";
import { BN } from "../src/i18n.bn";
import { AR } from "../src/i18n.ar";
import { boardPage, homePage } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";
import { LABELS, ruleName, ruleNotice, type Rule } from "../src/approvalRules";
import { approvalRulesSide } from "../src/approvalRulesUi";
import { approvalCardHtml } from "../src/approvalCard";

describe("languages (#1646)", () => {
  it("translates approval rules, category labels, errors and rule notes in every interface language", () => {
    const tables = [ZH_CN, ZH_HANT, ES, FR, JA, KO, HI, PT, DE, RU, ID, TR, BN, AR];
    const strings = ["Approval rules", ...Object.values(LABELS), "Always ask", "Auto-approve", "Block", "Rule", "Action", "Set by", "set by", "no longer an owner", "Spending threshold in dollars", "Over $", "Approved by rule", "Your agent asks here before side effects. Board rules can approve or block categorized work; other requests wait for you.", "Agents choose their own category. Block stops only agents that ask first. Auto-approve covers only the rule setter's own agents while that person is still an owner; other members' agents ask their own people. Spending under a positive threshold uses a daily total per board and person; requests over that total ask. Requests without a category always ask.", "Only a board owner can change approval rules. Ask your person.", "Other can only Always ask or Block."];
    for (const table of tables) for (const key of strings) expect(table[key], key).toBeTruthy();
    const rule: Rule = { category: "spending", name: LABELS.spending, mode: "auto", threshold: 25, set_by: "owner", updated_at: 1 };
    const html = approvalRulesSide([rule], true, [{ user: "owner", role: "owner" }], "zh-Hans");
    expect(html).toContain(ZH_CN["Spend money"]);
    expect(html).toContain(`aria-label="${ZH_CN["Spend money"]}"`);
    expect(html).toContain(ZH_CN["Over $"]);
    expect(html).not.toContain(">Spend money<");
    expect(ruleName("zh-Hans", "Spend money up to $25.00")).toContain(`${ZH_CN["Spend money"]} ${ZH_CN["up to $"]}25.00`);
    expect(approvalCardHtml({ id: "ap_1", user: "owner", status: "approved", rule_name: "Spend money up to $25.00", rule_set_by: "owner" }, true, "zh-Hans")).toContain(ZH_CN["Spend money"]);
    const notice = ruleNotice("zh-Hans", "owner", "Approval rule changed", "owner changed the approval rule: Spend money: Auto-approve over $25.00.");
    expect(notice).toContain(ZH_CN["Spend money"]);
    expect(notice).toContain(ZH_CN["Auto-approve"]);
    expect(notice).not.toContain("changed the approval rule");
    expect(ruleNotice("zh-Hans", "owner", "Approved by rule", "Approval ap_1 was approved by board rule Spend money up to $25.00 (set by owner)."))
      .toContain(ZH_CN["Spend money"]);
  });
  it("renders the approval panel in the board page's language", async () => {
    const rule: Rule = { category: "deploy_production", name: LABELS.deploy_production, mode: "ask", threshold: null, set_by: null, updated_at: null };
    const info: BoardInfo = { id: "b_test1234", title: "项目", created_by: "owner", created_at: 0, entry_count: 0, last_seq: 0 };
    const viewer = { name: "owner", email: "owner@example.com", display_name: null, admin: false, lang: "zh-Hans" as const };
    const html = await boardPage(viewer, [], info, [{ user: "owner", display_name: null, last_seen: 0, role: "owner" }], [], [], undefined, undefined, [], { picture: null, kind: null, approvalRules: [rule] }).text();
    expect(html).toContain(ZH_CN["Approval rules"]);
    expect(html).toContain(ZH_CN["Deploy to production"]);
    expect(html).toContain(ZH_CN["Agents choose their own category. Block stops only agents that ask first. Auto-approve covers only the rule setter's own agents while that person is still an owner; other members' agents ask their own people. Spending under a positive threshold uses a daily total per board and person; requests over that total ask. Requests without a category always ask."]);
    expect(html).not.toContain(">Deploy to production<");
  });
  it("picks ?lang=, then the saved pref, then the browser's Accept-Language, else English", () => {
    expect(pickLang(null, null, null)).toBe("en");
    expect(pickLang("auto", null, "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-Hans");
    expect(pickLang("en", null, "zh-CN")).toBe("en");
    expect(pickLang("zh-Hans", null, "en-US")).toBe("zh-Hans");
    expect(pickLang("en", "zh", "en-US")).toBe("zh-Hans");
    expect(pickLang("auto", "it", "it-IT,nl;q=0.5")).toBe("en"); // German is supported now (#2334): Italian and Dutch aren't
    expect(fromAcceptLanguage("it-IT, zh-Hans-CN;q=0.7, en;q=0.5")).toBe("zh-Hans");
    expect(fromAcceptLanguage("en;q=0.9, zh;q=0.95")).toBe("zh-Hans");
    expect(matchLang("zh-TW")).toBe("zh-Hant");
    expect(matchLang("zh-Hant-HK")).toBe("zh-Hant");
    expect(pickLang("zh-Hant", null, "zh-CN")).toBe("zh-Hant");
    expect(pickLang("ja", null, "zh-TW")).toBe("ja");
    expect(matchLang("it")).toBe(null);
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

describe("languages step 4 (#1786, #1842): Español, Français, 日本語, 한국어, हिन्दी", () => {
  const tables = { es: ES, fr: FR, ja: JA, ko: KO, hi: HI };
  it("are matched from the browser and the saved pref, and the picker names each in its own words", () => {
    expect(matchLang("es-MX")).toBe("es");
    expect(matchLang("es")).toBe("es");
    expect(matchLang("ja-JP")).toBe("ja");
    expect(matchLang("ko-KR")).toBe("ko");
    expect(matchLang("hi-IN")).toBe("hi");
    expect(matchLang("fr-CA")).toBe("fr");
    expect(pickLang("fr", null, "en-US")).toBe("fr");
    expect(matchLang("eu")).toBe(null); // Basque is not Spanish
    expect(fromAcceptLanguage("it-IT, ko;q=0.8, en;q=0.5")).toBe("ko");
    expect(pickLang("hi", null, "en-US")).toBe("hi");
    expect(pickLang("auto", null, "es-419,es;q=0.9")).toBe("es");
    expect(LANG_NAMES).toMatchObject({ es: "Español", fr: "Français", ja: "日本語", ko: "한국어", hi: "हिन्दी" });
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
    for (const lang of ["es", "fr", "ja", "ko", "hi"] as const) {
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

describe("the top languages (vedu #2334): Português, Deutsch, Русский, Bahasa Indonesia, Türkçe, বাংলা, العربية", () => {
  const tables = { pt: PT, de: DE, ru: RU, id: ID, tr: TR, bn: BN, ar: AR };
  it("are matched from the browser and the saved pref, and the picker names each in its own words", () => {
    expect(matchLang("pt-BR")).toBe("pt");
    expect(matchLang("pt-PT")).toBe("pt");
    expect(matchLang("de-AT")).toBe("de");
    expect(matchLang("ru")).toBe("ru");
    expect(matchLang("id-ID")).toBe("id");
    expect(matchLang("in-ID")).toBe("id"); // the old code for Indonesian
    expect(matchLang("tr-TR")).toBe("tr");
    expect(matchLang("bn-BD")).toBe("bn");
    expect(matchLang("ar-EG")).toBe("ar");
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("de")).toBe("ltr");
    expect(fromAcceptLanguage("nl-NL, de;q=0.8, en;q=0.5")).toBe("de");
    expect(pickLang("auto", null, "pt-BR,pt;q=0.9")).toBe("pt");
    expect(LANG_NAMES).toMatchObject({ pt: "Português", de: "Deutsch", ru: "Русский", id: "Bahasa Indonesia", tr: "Türkçe", bn: "বাংলা", ar: "العربية" });
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
  });
  it("the board page and home render in each, with scripts that compile", async () => {
    const info: BoardInfo = { id: "b_test1234", title: "pagos", created_by: "jxn", created_at: 0, entry_count: 1, last_seq: 1 };
    for (const lang of ["pt", "de", "ru", "id", "tr", "bn", "ar"] as const) {
      const viewer = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang };
      const res = boardPage(viewer, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }], [], []);
      const html = await res.text();
      expect(res.headers.get("content-language")).toBe(lang);
      expect(html).toContain(lang === "ar" ? `<html lang="ar" dir="rtl">` : `<html lang="${lang}">`); // Arabic reads right to left
      expect(html).toContain(tables[lang]["Send"]);
      for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
      expect(await homePage(viewer, [], []).text()).toContain(tables[lang]["New board"]);
    }
  });
});

describe("Just mine on the web (#1825)", () => {
  it("the composer offers People only or Just mine, posts own, and the 🔒 badge speaks the page's language", async () => {
    const info: BoardInfo = { id: "b_test1234", title: "lane", created_by: "jxn", created_at: 0, entry_count: 1, last_seq: 1 };
    const e = { seq: 1, ts: 1, author: "jxn", type: "note", text: "for my agent", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "person", audience: "own", to_people: ["jxn"] } as Entry;
    const members = [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0 }];
    for (const [lang, word, mine] of [["en", "just mine", "Just mine"], ["zh-Hans", "仅自己", "仅自己"], ["ja", "自分だけ", "自分だけ"]] as const) {
      const html = await boardPage({ name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang }, [], info, members, [e], []).text();
      expect(html).toContain('name="own" id="own-in"');
      expect(html).toContain(`data-po="own" aria-checked="false">${mine}</button>`);
      expect(html).toContain(`data-own="1">🔒 ${word}</span>`);
    }
  });
});
