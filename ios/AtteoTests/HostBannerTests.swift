// atteo host (docs/HOST.md; vedu #4815): the board's red banner names only machines that are online and not stopped,
// and offers Stop to the machine's owner and the board's owner only (the server checks again).

import XCTest
@testable import Atteo

final class HostBannerTests: XCTestCase {
    private func hosts() throws -> [HostInfo] {
        let json = #"{"hosts":[{"id":"h_1","name":"mac","owner":"jxn","shares":["/p"],"online":true,"stopped_at":null},{"id":"h_2","name":"old","owner":"jxn","shares":["/p"],"online":false,"stopped_at":null},{"id":"h_3","name":"gone","owner":"vedu","shares":["/q"],"online":true,"stopped_at":1700000000000}]}"#
        return try JSONDecoder.soup.decode(HostsResponse.self, from: Data(json.utf8)).hosts
    }

    func testBannerNamesOnlyOnlineUnstoppedMachines() throws {
        XCTAssertEqual(onlineHosts(try hosts()).map(\.name), ["mac"])
    }

    func testStopIsForTheMachinesOwnerOrTheBoardsOwner() throws {
        let mac = try hosts()[0]
        XCTAssertTrue(canStopHost(mac, me: "jxn", boardOwner: "vedu"))
        XCTAssertTrue(canStopHost(mac, me: "vedu", boardOwner: "vedu"))
        XCTAssertFalse(canStopHost(mac, me: "ann", boardOwner: "vedu"))
        XCTAssertFalse(canStopHost(mac, me: nil, boardOwner: nil))
    }
}
