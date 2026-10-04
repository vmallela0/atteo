// Talk to Atteo's spoken yes (TalkYes.swift) in each of the app's languages: a plain short yes passes, a hedged yes
// doesn't, and a no is a no. The Korean prompt says "네", the French one "oui"…: each prompt's word is accepted.

import XCTest
@testable import Atteo

final class TalkYesTests: XCTestCase {
    private func check(_ cases: [(String, TalkYes.Verdict)], to decision: String = "approve", line: UInt = #line) {
        for (said, want) in cases { XCTAssertEqual(TalkYes.verdict(said, to: decision), want, "\"\(said)\"", line: line) }
    }

    func testEnglishStaysTheSame() {
        check([("yes", .yes), ("Yeah, go ahead.", .yes), ("approve it", .yes), ("yes but first check the logs", .unclear),
               ("Yes?", .unclear), ("no", .no), ("deny it", .no), ("what would that do", .unclear)])
        check([("send it", .yes), ("don't send it", .no)], to: "post")
    }

    func testKorean() {
        check([("네", .yes), ("네.", .yes), ("네네", .yes), ("예", .yes), ("응", .yes), ("예, 보내 주세요", .yes)])
        check([("네 근데 먼저 확인해 줘", .unclear), ("네, 먼저 테스트부터", .unclear), ("네?", .unclear)])
        check([("아니요", .no), ("아니", .no), ("아니요, 하지 마세요", .no)])
    }

    func testFrench() {
        check([("Oui", .yes), ("Oui.", .yes), ("D’accord", .yes), ("d'accord", .yes), ("Vas-y", .yes), ("oui, vas-y", .yes)])
        check([("Oui mais d'abord vérifie", .unclear), ("Oui, mais pas maintenant", .unclear), ("D’abord les tests", .unclear), ("Oui ?", .unclear)])
        check([("Non", .no), ("Attends", .no), ("non merci", .no)])
    }

    func testHindi() {
        check([("हाँ", .yes), ("हां", .yes), ("जी हाँ", .yes), ("ठीक है", .yes), ("हाँ, भेज दो", .yes)])
        check([("हाँ लेकिन पहले देखो", .unclear), ("हाँ, पहले टेस्ट चलाओ", .unclear), ("हाँ?", .unclear)])
        check([("नहीं", .no), ("रुको", .no), ("नहीं, अभी नहीं", .no)])
    }

    func testSpanish() {
        check([("Sí", .yes), ("sí, sí", .yes), ("Vale", .yes), ("Adelante", .yes), ("Sí, adelante.", .yes)])
        // A decomposed accent ("si" + U+0301) is the same "sí"; a bare "si" is "if", not a yes.
        check([("Si\u{0301}", .yes), ("Si", .unclear)])
        check([("Sí, pero primero revisa", .unclear), ("Primero los tests", .unclear), ("¿Sí?", .unclear)])
        check([("No", .no), ("Espera", .no), ("No, espera", .no)])
    }

    func testJapanese() {
        check([("はい", .yes), ("はい。", .yes), ("お願いします", .yes), ("はい、お願いします", .yes)])
        check([("はい、でもまず確認して", .unclear), ("まずテストして", .unclear), ("はい？", .unclear), ("お願いできますか", .unclear)])
        check([("いいえ", .no), ("待って", .no), ("ちょっと待って", .no)])
    }

    func testChinese() {
        check([("是", .yes), ("是的", .yes), ("好", .yes), ("好的", .yes), ("对", .yes), ("可以", .yes), ("確認", .yes), ("好的，发吧", .yes)], to: "post")
        check([("好，但是先等一下", .unclear), ("先跑测试", .unclear), ("可以吗", .unclear), ("好？", .unclear)])
        check([("不", .no), ("不要", .no), ("等等", .no), ("不是", .no), ("不对", .no)])
    }

    /// Short: 6 words, or 8 characters in Chinese and Japanese (no spaces).
    func testLength() {
        check([("yes yes yes yes yes yes", .yes), ("yes yes yes yes yes yes yes", .unclear)])
        check([("はい、お願いします", .yes), ("好的好的好的好的", .yes), ("好的好的好的好的好", .unclear)])
        check([("네 네 네 네 네 네", .yes), ("oui oui oui oui oui oui oui", .unclear)])
    }
}
