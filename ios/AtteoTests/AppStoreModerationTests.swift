// App Review 5.1.2(i) and 1.2 (docs/APP_STORE_READINESS.md): nothing goes to xAI before the person's OK, and the
// app can report a message, mute someone and hide offensive words.

import XCTest
@testable import Atteo

@MainActor
final class AppStoreModerationTests: XCTestCase {
    private var saved: Any?

    override func setUp() {
        super.setUp()
        saved = UserDefaults.standard.object(forKey: AIConsent.key)
        UserDefaults.standard.removeObject(forKey: AIConsent.key)
    }

    override func tearDown() {
        if let saved { UserDefaults.standard.set(saved, forKey: AIConsent.key) } else { UserDefaults.standard.removeObject(forKey: AIConsent.key) }
        super.tearDown()
    }

    func testWhichRoutesSendToXAI() {
        XCTAssertTrue(AIConsent.sendsToXAI("/api/app/voice/session"))
        XCTAssertTrue(AIConsent.sendsToXAI("/api/app/tts"))
        XCTAssertFalse(AIConsent.sendsToXAI("/api/app/voice/status"), "a status check sends nothing")
        XCTAssertFalse(AIConsent.sendsToXAI("/api/app/tts/status"))
        XCTAssertFalse(AIConsent.sendsToXAI("/api/boards/b_x/entries"))
        // Ours only (jxn's agent #4386): a call open at revoke still settles its minutes and checks autosend.
        XCTAssertFalse(AIConsent.sendsToXAI("/api/app/voice/session/end"))
        XCTAssertFalse(AIConsent.sendsToXAI("/api/app/voice/autosend"))
    }

    func testServerRefusalAndSync() {
        XCTAssertTrue(AIConsent.isRefusal(403, ["needs_consent": true, "error": "x"]))
        XCTAssertFalse(AIConsent.isRefusal(403, ["error": "Voice is for people"]), "another 403 isn't a consent refusal")
        XCTAssertFalse(AIConsent.isRefusal(200, ["needs_consent": true]))
        AIConsent.sync(true)
        XCTAssertTrue(AIConsent.xai, "the server's OK lands on this phone")
        AIConsent.sync(false)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: AIConsent.key), false, "and so does a withdrawal from another device")
        AIConsent.sync(nil)
        XCTAssertEqual(UserDefaults.standard.bool(forKey: AIConsent.key), false, "an old server (no field) changes nothing")
    }

    func testEndAndAutosendNotBlockedAfterRevoke() {
        UserDefaults.standard.set(false, forKey: AIConsent.key)
        XCTAssertNoThrow(try AIConsent.check("/api/app/voice/session/end"))
        XCTAssertNoThrow(try AIConsent.check("/api/app/voice/autosend"))
    }

    func testNoVoiceSessionBeforeConsent() async throws {
        try XCTSkipIf(TalkAPI.fake, "the fake voice never reaches xAI, so it needs no OK")
        XCTAssertFalse(AIConsent.xai)
        do {
            _ = try await TalkAPI.call("POST", "/api/app/voice/session", body: ["hands_free": true])
            XCTFail("a voice session started without consent")
        } catch is AIConsent.Missing {
            // refused before any request: Missing is thrown ahead of the token check and the network
        } catch {
            XCTFail("expected AIConsent.Missing, got \(error)")
        }
        do { _ = try await TalkAPI.raw("POST", "/api/app/tts", body: ["board": "b_x", "seq": 1]); XCTFail("tts without consent") }
        catch is AIConsent.Missing {}
    }

    func testConsentLetsTheCallThrough() async {
        AIConsent.xai = true
        XCTAssertTrue(AIConsent.xai)
        do { _ = try await TalkAPI.call("GET", "/api/app/voice/status") } catch {
            XCTAssertFalse(error is AIConsent.Missing, "after the OK, voice routes aren't refused for consent")
        }
        do { try AIConsent.check("/api/app/voice/session") } catch { XCTFail("refused after consent") }
    }

    func testOffensiveWordsMasked() {
        XCTAssertEqual(OffensiveFilter.apply("what the fuck is this", enabled: true), "what the f••• is this")
        XCTAssertEqual(OffensiveFilter.apply("SHIT happens", enabled: true), "S••• happens")
        XCTAssertEqual(OffensiveFilter.apply("Scunthorpe and shitake are fine", enabled: true), "Scunthorpe and shitake are fine", "whole words only")
        XCTAssertEqual(OffensiveFilter.apply("what the fuck", enabled: false), "what the fuck", "off: as written")
        XCTAssertEqual(OffensiveFilter.apply("all clean", enabled: true), "all clean")
    }

    func testReportIsAnAction() {
        var a = EntryActions()
        XCTAssertFalse(a.shape.last!)
        a.report = {}
        XCTAssertTrue(a.shape.last!, "a row with Report differs from one without")
    }

    func testMutesAreKeptPerBoard() {
        let s = AppState()
        s.mutes["b_x"] = ["theo"]
        XCTAssertTrue(s.isMuted("Theo", on: "b_x"))
        XCTAssertFalse(s.isMuted("theo", on: "b_y"))
        XCTAssertFalse(s.isMuted("maya", on: "b_x"))
    }
}
