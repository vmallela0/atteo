import { describe, expect, it } from "vitest";
import { fromAcceptLanguage, matchLang, pickLang, tr } from "../src/i18n";
import { ZH_CN } from "../src/i18n.zh";
import { boardPage, homePage } from "../src/html";
import type { BoardInfo, Entry } from "../src/types";

describe("languages (#1646)", () => {
  it("picks ?lang=, then the saved pref, then the browser's Accept-Language, else English", () => {
    expect(pickLang(null, null, null)).toBe("en");
    expect(pickLang("auto", null, "zh-CN,zh;q=0.9,en;q=0.8")).toBe("zh-CN");
    expect(pickLang("en", null, "zh-CN")).toBe("en");
    expect(pickLang("zh-CN", null, "en-US")).toBe("zh-CN");
    expect(pickLang("en", "zh", "en-US")).toBe("zh-CN");
    expect(pickLang("auto", "fr", "de-DE,fr;q=0.5")).toBe("en");
    expect(fromAcceptLanguage("fr-FR, zh-Hans-CN;q=0.7, en;q=0.5")).toBe("zh-CN");
    expect(fromAcceptLanguage("en;q=0.9, zh;q=0.95")).toBe("zh-CN");
    expect(matchLang("zh-TW")).toBe(null); // Traditional isn't here yet: falls through to the next choice
  });

  it("translates by the English string, fills {placeholders}, and falls back to the English", () => {
    expect(tr("zh-CN", "Boards")).toBe("看板");
    expect(tr("zh-CN", "{n}m ago", { n: 5 })).toBe("5 分钟前");
    expect(tr("zh-CN", "Not in the table")).toBe("Not in the table");
    expect(tr("en", "{name}'s agent", { name: "vedu" })).toBe("vedu's agent");
    expect(tr(undefined, "Boards")).toBe("Boards");
    for (const [k, v] of Object.entries(ZH_CN)) {
      // Every {placeholder} in the English is kept in the Chinese.
      for (const ph of k.match(/\{\w+\}/g) ?? []) expect(v, k).toContain(ph);
      expect(v.trim(), k).not.toBe("");
    }
  });

  const info: BoardInfo = { id: "b_test1234", title: "支付 bug", created_by: "jxn", created_at: 0, entry_count: 1, last_seq: 1 };
  const entries: Entry[] = [{ seq: 1, ts: 1, author: "vedu", type: "question", text: "Can you check?", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent" }];
  const viewer = { name: "jxn", email: "jxn@example.com", display_name: null, admin: false, lang: "zh-CN" as const };

  it("the board page in zh-CN: html lang, the table for its scripts, Chinese chrome, people's words untouched, scripts compile", async () => {
    const res = boardPage(viewer, [], info, [{ user: "jxn", display_name: null, last_seen: 0 }, { user: "vedu", display_name: null, last_seen: 0 }], entries, []);
    const html = await res.text();
    expect(res.headers.get("content-language")).toBe("zh-CN");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("window.I18N={");
    for (const zh of ["对话", "发送", "看板信息", "回复", "问题"]) expect(html).toContain(zh);
    expect(html).toContain("Can you check?"); // a message is never translated
    for (const s of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) expect(() => new Function(s)).not.toThrow();
  });

  it("home in zh-CN, and English stays English with no table", async () => {
    const zh = await homePage(viewer, [], []).text();
    for (const w of ["看板", "新建看板", "添加你的智能体"]) expect(zh).toContain(w);
    const en = await homePage({ ...viewer, lang: "en" }, [], []).text();
    expect(en).toContain('<html lang="en">');
    expect(en).not.toContain("window.I18N=");
    expect(en).toContain("New board");
  });
});
