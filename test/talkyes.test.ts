// Talk to Atteo's spoken yes on the web (talk.ts TALK_YES, #2061), the same cases as the app's TalkYesTests (#2060):
// a plain short yes passes in every language, a hedged yes doesn't, and a no is a no. English stays exactly as strict.
import { describe, expect, it } from "vitest";
import { TALK_YES } from "../src/talk";

type Verdict = "yes" | "no" | "unclear";
const talkVerdict = new Function(`${TALK_YES};return talkVerdict`)() as (said: string, d: string) => Verdict;
const check = (cases: [string, Verdict][], d = "approve") => {
  for (const [said, want] of cases) expect([said, talkVerdict(said, d)]).toEqual([said, want]);
};

describe("talk: what a spoken answer means", () => {
  it("English stays the same: exactly a short yes", () => {
    check([["yes", "yes"], ["Yes.", "yes"], ["Yeah, go ahead.", "unclear"], ["go ahead", "yes"], ["approve it", "yes"], ["ok yes please", "yes"],
      ["yes but first check the logs", "unclear"], ["Sure, but first tell me what it does", "unclear"], ["Yes?", "unclear"], ["Yes, do it after lunch?", "unclear"],
      ["yeah let me think", "unclear"], ["no", "no"], ["No, don't.", "no"], ["deny it", "no"], ["what would that do", "unclear"]]);
    check([["send it", "yes"], ["post", "yes"], ["don't send it", "no"]], "post");
    check([["deny it", "yes"], ["approve it", "no"]], "deny");
  });
  it("Korean", () => {
    check([["네", "yes"], ["네.", "yes"], ["네네", "yes"], ["예", "yes"], ["응", "yes"], ["예, 보내 주세요", "yes"]]);
    check([["네 근데 먼저 확인해 줘", "unclear"], ["네, 먼저 테스트부터", "unclear"], ["네?", "unclear"], ["네 생각해 볼게요", "unclear"]]);
    check([["아니요", "no"], ["아니", "no"], ["아니요, 하지 마세요", "no"]]);
  });
  it("French", () => {
    check([["Oui", "yes"], ["Oui.", "yes"], ["D’accord", "yes"], ["d'accord", "yes"], ["Vas-y", "yes"], ["oui, vas-y", "yes"]]);
    check([["Oui mais d'abord vérifie", "unclear"], ["Oui, mais pas maintenant", "unclear"], ["D’abord les tests", "unclear"], ["Oui ?", "unclear"], ["oui je vais réfléchir", "unclear"]]);
    check([["Non", "no"], ["Attends", "no"], ["non merci", "no"]]);
  });
  it("Hindi", () => {
    check([["हाँ", "yes"], ["हां", "yes"], ["जी हाँ", "yes"], ["ठीक है", "yes"], ["हाँ, भेज दो", "yes"]]);
    check([["हाँ लेकिन पहले देखो", "unclear"], ["हाँ, पहले टेस्ट चलाओ", "unclear"], ["हाँ?", "unclear"]]);
    check([["नहीं", "no"], ["रुको", "no"], ["नहीं, अभी नहीं", "no"]]);
  });
  it("Spanish (a bare si is 'if')", () => {
    check([["Sí", "yes"], ["sí, sí", "yes"], ["Vale", "yes"], ["Adelante", "yes"], ["Sí, adelante.", "yes"], ["Sí", "yes"], ["Si", "unclear"]]);
    check([["Sí, pero primero revisa", "unclear"], ["Primero los tests", "unclear"], ["¿Sí?", "unclear"]]);
    check([["No", "no"], ["Espera", "no"], ["No, espera", "no"]]);
  });
  it("Japanese", () => {
    check([["はい", "yes"], ["はい。", "yes"], ["お願いします", "yes"], ["はい、お願いします", "yes"]]);
    check([["はい、でもまず確認して", "unclear"], ["まずテストして", "unclear"], ["はい？", "unclear"], ["お願いできますか", "unclear"]]);
    check([["いいえ", "no"], ["待って", "no"], ["ちょっと待って", "no"]]);
  });
  it("Chinese", () => {
    check([["是", "yes"], ["是的", "yes"], ["好", "yes"], ["好的", "yes"], ["对", "yes"], ["可以", "yes"], ["確認", "yes"], ["好的，发吧", "yes"]], "post");
    check([["好，但是先等一下", "unclear"], ["先跑测试", "unclear"], ["可以吗", "unclear"], ["好？", "unclear"], ["好吧我再想想", "unclear"]]);
    check([["不", "no"], ["不要", "no"], ["等等", "no"], ["不是", "no"], ["不对", "no"]]);
  });
  it("short: 4 words, or 8 characters in Chinese and Japanese", () => {
    check([["네 네 네 네", "yes"], ["네 네 네 네 네", "unclear"], ["oui oui oui oui oui", "unclear"]]);
    check([["はい、お願いします", "yes"], ["好的好的好的好的", "yes"], ["好的好的好的好的好", "unclear"]]);
  });
  it("any language counts, and an empty or odd transcript is never a yes", () => {
    check([["", "unclear"], ["...", "unclear"], ["123", "unclear"], ["yes 네", "yes"], ["oui no", "no"]]);
  });
});
