// The list of assistants to connect (jxn #4124): A–Z by name, the coding agent last, and each tool with its logo.

import UIKit
import XCTest
@testable import Atteo

final class ProviderListTests: XCTestCase {
    func testTilesAreAlphabetical() {
        XCTAssertEqual(AssistantProvider.tiles.map(\.name), ["ChatGPT", "Claude", "Grok", "Muse"])
    }

    func testInviteListKeepsTheCodingAgentLast() {
        XCTAssertEqual((AssistantProvider.tiles + [.coding]).last, .coding)
    }

    func testEachToolHasALogoInTheCatalog() {
        for p in AssistantProvider.tiles {
            let name = try! XCTUnwrap(p.logo, "\(p.name) has a logo")
            XCTAssertNotNil(UIImage(named: name), "\(name) is in the asset catalog")
        }
        XCTAssertNil(AssistantProvider.coding.logo, "a coding agent keeps </>")
    }
}
