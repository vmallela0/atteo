import XCTest
import UIKit
@testable import Atteo

final class DisplayNameTests: XCTestCase {
    @MainActor private func state() -> AppState {
        let state = AppState()
        state.profile = nil
        state.displayNames = [:]
        return state
    }

    @MainActor func testDisplayNamePresent() {
        let state = state()
        state.rememberDisplayName("Jane Doe", for: "jane")
        XCTAssertEqual(state.displayName(for: "jane"), "Jane Doe")
        XCTAssertEqual(state.displayName(for: "JANE"), "Jane Doe")
    }

    @MainActor func testEmptyDisplayNameFallsBackAndReplacesOldName() {
        let state = state()
        state.rememberDisplayName("Jane Doe", for: "jane")
        for empty in ["", " \n ", nil] as [String?] {
            state.rememberDisplayName(empty, for: "jane")
            XCTAssertEqual(state.displayName(for: "jane"), "jane")
        }
    }

    @MainActor func testUnknownUserFallsBackToHandle() {
        XCTAssertEqual(state().displayName(for: "unknown"), "unknown")
    }

    @MainActor func testAgentUsesOwnersDisplayName() {
        let state = state()
        state.rememberDisplayName("Jane Doe", for: "jane")
        XCTAssertEqual(state.displayName(for: "jane", agent: true), Vocab.agentOf("Jane Doe"))
        XCTAssertEqual(state.displayName(for: "jane's agent"), Vocab.agentOf("Jane Doe"))
        XCTAssertEqual(state.displayName(for: "jane’s assistant"), Vocab.agentOf("Jane Doe"))
        XCTAssertEqual(state.displayName(for: "jane/scout"), Vocab.agentOf("Jane Doe") + " · scout")
        XCTAssertEqual(state.displayName(for: "unknown", agent: true), Vocab.agentOf("unknown"))
        state.rememberDisplayName("", for: "jane")
        XCTAssertEqual(state.displayName(for: "jane's agent"), Vocab.agentOf("jane"))
    }

    @MainActor func testAgentUsesItsOwnDisplayNameWhenKnown() {
        let state = state()
        state.rememberDisplayName("Jane Doe", for: "jane")
        state.agentNames["board"] = ["jane": AppState.AgentName(name: "Bender", ambiguous: false)]
        XCTAssertEqual(state.displayName(for: "jane's agent", board: "board"), "Bender · jane's agent")
        XCTAssertEqual(state.displayName(for: "jane/scout", board: "board"), "Bender · jane's agent · scout")
        state.agentNames["board"] = ["jane": AppState.AgentName(name: "Your agent", ambiguous: false)]
        XCTAssertEqual(state.displayName(for: "jane's agent", board: "board"), "Your agent · jane's agent", "stored names rejected for new edits still show with their owner")
        state.agentNames["board"] = ["jane": AppState.AgentName(name: "Bender", ambiguous: false)]
        XCTAssertEqual(state.displayName(for: "jane", board: "board"), "Jane Doe")
        state.agentNames["old"] = state.agentNames["board"]
        state.agentNames["board"] = [:]
        XCTAssertEqual(state.displayName(for: "jane's agent", board: "board"), Vocab.agentOf("Jane Doe"), "a cleared name does not use a stale name from another board")
    }

    @MainActor func testOwnProfileTakesPrecedenceIncludingClearedName() throws {
        let state = state()
        state.rememberDisplayName("Old name", for: "jane")
        state.profile = try JSONDecoder.soup.decode(Profile.self, from: Data(#"{"name":"jane","display_name":"Jane Doe","listed":true,"rules":{}}"#.utf8))
        XCTAssertEqual(state.displayName(for: "jane"), "Jane Doe")
        state.profile?.displayName = ""
        XCTAssertEqual(state.displayName(for: "jane"), "jane")
    }

    @MainActor func testNotificationSenderAlwaysShowsNamedAgentsOwner() {
        let state = state()
        let item = InboxItem(id: 1, boardId: "b_test", boardTitle: "Test", seq: 1, kind: "mention", actor: "jane", actorVia: "agent", actorName: "Your agent", excerpt: "hi", createdAt: 0, readAt: nil)
        XCTAssertEqual(Notifier.senderName(item, state: state), "Your agent · jane's agent")
        state.agentNames["board"] = ["jane": AppState.AgentName(name: "Bender", ambiguous: false)]
        var older = item
        older.actorName = nil
        XCTAssertEqual(Notifier.senderName(older, state: state), "Bender · jane's agent")
    }

    func testMemberAndProfileAPIsDecodeDisplayName() throws {
        let data = Data(#"{"members":[{"user":"jane","display_name":"Jane Doe","agent_name":"Bender","agent_name_ambiguous":true,"role":"owner"},{"user":"unknown","agent_name":"bender","agent_name_ambiguous":true,"role":"member"}]}"#.utf8)
        let members = try JSONDecoder.soup.decode(MembersResponse.self, from: data).members
        let boardMembers = try JSONDecoder.soup.decode(BoardMembersResponse.self, from: data).members
        XCTAssertEqual(members[0].displayName, "Jane Doe")
        XCTAssertNil(members[1].displayName)
        XCTAssertEqual(boardMembers[0].displayName, "Jane Doe")
        XCTAssertEqual(try JSONDecoder.soup.decode(BoardMembersResponse.self, from: data).ambiguousAgentNames, ["Bender"])
        let person = try JSONDecoder.soup.decode(PersonResponse.self, from: Data(#"{"person":{"name":"jane","display_name":"Jane Doe","relation":"friend"}}"#.utf8)).person
        XCTAssertEqual(person.displayName, "Jane Doe")
    }

    @MainActor func testComposerChipsPreserveTypedHandlesAndSelection() {
        let state = state()
        state.rememberDisplayName("Zoë 王", for: "jane")
        let box = ComposerField.Box()
        box.font = Typo.composer
        box.members = ["jane"]
        box.displayName = { state.displayName(for: $0) }
        let draft = "Hi @jane, ask @jane's agent and @all 👋"
        box.text = draft
        box.selectedRange = NSRange(location: draft.utf16.count, length: 0)
        box.restyle()
        XCTAssertEqual(box.text, "Hi Zoë 王, ask \(Vocab.agentOf("Zoë 王")) and @all 👋")
        XCTAssertEqual(box.rawText, draft)
        XCTAssertEqual(box.selectedRange.location, box.text.utf16.count)
        XCTAssertEqual(box.tokenRanges().count, 3)
        state.rememberDisplayName("A much longer name", for: "jane")
        box.restyle()
        XCTAssertEqual(box.rawText, draft, "renaming a chip must not change a draft or who it mentions")
        XCTAssertEqual(box.selectedRange.location, box.text.utf16.count)
        let first = box.tokenRanges()[0]
        box.textStorage.replaceCharacters(in: first, with: "")
        box.restyle()
        XCTAssertEqual(box.rawText, "Hi , ask @jane's agent and @all 👋")
    }
}
