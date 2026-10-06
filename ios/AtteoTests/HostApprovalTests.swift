import XCTest
@testable import Atteo

/// atteo host's approvals in the app (jxn's agent #4928/#4929): a command or a high-risk ask is never approved from the
/// one-line row; the detail shows the whole command and calls out non-ASCII characters.
final class HostApprovalTests: XCTestCase {
    private func approval(risk: String, command: String? = nil) -> Approval {
        var a = Approval(id: "ap", client: "atteo host", boardId: "b", title: "Run", details: "", risk: risk, status: "pending", createdAt: 0)
        a.command = command
        return a
    }

    func testHighRiskOrACommandNeedsTheDetailFirst() {
        XCTAssertTrue(ApprovalRow.reviewFirst(approval(risk: "high")))
        XCTAssertTrue(ApprovalRow.reviewFirst(approval(risk: "low", command: "ls")))
        XCTAssertFalse(ApprovalRow.reviewFirst(approval(risk: "low")))
        XCTAssertFalse(ApprovalRow.reviewFirst(approval(risk: "medium")))
    }

    func testNonASCIIIsCalledOut() {
        XCTAssertFalse(ApprovalDetail.hasNonASCII("git status\n\tmake test"))
        XCTAssertTrue(ApprovalDetail.hasNonASCII("cаt secret")) // a Cyrillic а
        XCTAssertTrue(ApprovalDetail.hasNonASCII("ls \u{202E}txt"))
        XCTAssertTrue(ApprovalDetail.hasNonASCII("echo héllo"))
    }

    /// jxn #4945: the banner says when a machine's commands can reach the network.
    func testTheBannerSaysWhenAMachineHasNetwork() throws {
        let json = #"{"hosts":[{"id":"h_1","name":"box","owner":"vedu","shares":["/p"],"online":true,"stopped_at":null,"network":true},{"id":"h_2","name":"mac","owner":"jxn","shares":["/q"],"online":true,"stopped_at":null}]}"#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let hosts = try d.decode(HostsResponse.self, from: Data(json.utf8)).hosts
        XCTAssertEqual(hostLabel(hosts[0]), "vedu's box (network on)")
        XCTAssertEqual(hostLabel(hosts[1]), "jxn's mac")
    }
}
