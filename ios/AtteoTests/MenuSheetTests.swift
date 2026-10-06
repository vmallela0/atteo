import XCTest
@testable import Atteo

final class MenuSheetTests: XCTestCase {
    private func board(live: Int? = 8) -> Board {
        Board(id: "board", title: "Atteo", kind: "board", entryCount: 0,
              lastActivity: 0, encrypted: false, last: nil, liveAgents: live)
    }

    private func approval(_ id: String, board: String?, status: String = "pending") -> Approval {
        Approval(id: id, client: nil, boardId: board, title: "Approval", details: "",
                 risk: "low", status: status, createdAt: 0)
    }

    func testOnlyPendingApprovalsOnThisBoardOverrideWorking() {
        let status = MenuBoardStatus(board: board(), agents: nil, approvals: [
            approval("waiting", board: "board"),
            approval("resolved", board: "board", status: "approved"),
            approval("other", board: "another-board"),
            approval("personal", board: nil),
        ])
        XCTAssertEqual(status.working, 8)
        XCTAssertEqual(status.approvals, 1)
        XCTAssertEqual(status.activity, .approval)
    }

    func testLoadedPresenceReplacesSummaryAndCountsOnlyLiveSessions() {
        let agents = ["live", "live", "idle", "gone"].enumerated().map { index, state in
            BoardAgent(user: "person", name: "session-\(index)", client: nil,
                       status: nil, lastSeen: 0, state: state)
        }
        let status = MenuBoardStatus(board: board(), agents: agents, approvals: [])
        XCTAssertEqual(status.working, 2, "Count sessions, including multiple sessions belonging to one person")
        XCTAssertEqual(status.activity, .working)
        XCTAssertEqual(MenuBoardStatus(board: board(), agents: [], approvals: []).activity, .quiet)
    }

    func testMissingPresenceUsesSummaryAndUnknownOrInvalidCountsAreQuiet() {
        XCTAssertEqual(MenuBoardStatus(board: board(), agents: nil, approvals: []).working, 8)
        for live in [nil, -1, 0] as [Int?] {
            let status = MenuBoardStatus(board: board(live: live), agents: nil, approvals: [])
            XCTAssertEqual(status.working, 0)
            XCTAssertEqual(status.activity, .quiet)
        }
    }
}
