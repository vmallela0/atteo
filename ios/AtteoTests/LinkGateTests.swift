// Links that leave Atteo ask first (jxn #4173); Atteo's own links and the app's own schemes don't.

import XCTest
@testable import Atteo

final class LinkGateTests: XCTestCase {
    private let server = "agent-board.vedu-mallela.workers.dev"
    private func ask(_ s: String) -> Bool { LinkGate.needsConfirm(URL(string: s)!, serverHost: server) }

    func testAtteoItselfOpensWithoutAsking() {
        XCTAssertFalse(ask("https://atteo.dev/b/b_skyvcqtm7fei"))
        XCTAssertFalse(ask("https://ATTEO.dev/faq"), "host case doesn't matter")
        XCTAssertFalse(ask("https://docs.atteo.dev/mcp"), "a subdomain is still Atteo")
        XCTAssertFalse(ask("https://agent-board.vedu-mallela.workers.dev/b/x"))
    }

    func testTheAppsOwnLinksNeverAsk() {
        XCTAssertFalse(ask("atteo-entry://123"))
        XCTAssertFalse(ask("atteo-person://theo?agent=1"))
        XCTAssertFalse(ask("atteo-group://agents"))
    }

    func testOtherSitesAsk() {
        XCTAssertTrue(ask("https://github.com/vmallela0/agent-soup/pull/58"))
        XCTAssertTrue(ask("https://example.com"))
    }

    func testLookalikesAsk() {
        XCTAssertTrue(ask("https://atteo.dev.evil.com/login"), "atteo.dev as a prefix of someone else's host")
        XCTAssertTrue(ask("https://evilatteo.dev/"), "a host that only ends in the same letters")
        XCTAssertTrue(ask("https://atteo.dev@evil.com/"), "user-info trick: the host is evil.com")
    }

    func testLeavingTheAppAsks() {
        XCTAssertTrue(ask("mailto:someone@example.com"))
        XCTAssertTrue(ask("tel:+15555550100"))
    }

    func testAnHTTPDowngradeAsks() {
        XCTAssertTrue(ask("http://atteo.dev/b/x"), "not over https, so not trusted as Atteo")
    }

    func testARowPreviewHasNoTappableLinks() {
        let p = "The fix is in [the PR](https://github.com/x/y/pull/1) and https://example.com".mdPreview
        XCTAssertTrue(p.runs.allSatisfy { $0.link == nil }, "a link in the preview would take the row's tap")
        XCTAssertEqual(String(p.characters), String("The fix is in [the PR](https://github.com/x/y/pull/1) and https://example.com".md.characters))
    }

    func testTheAddressIsShownWholeWithItsHostApart() {
        let p = LinkGate.parts(URL(string: "https://github.com/vmallela0/agent-soup/pull/58?x=1")!)
        XCTAssertEqual(p.lead, "https://")
        XCTAssertEqual(p.host, "github.com")
        XCTAssertEqual(p.rest, "/vmallela0/agent-soup/pull/58?x=1")
        XCTAssertEqual(p.lead + p.host + p.rest, "https://github.com/vmallela0/agent-soup/pull/58?x=1")
        let trick = LinkGate.parts(URL(string: "https://atteo.dev@evil.com/login")!)
        XCTAssertEqual(trick.host, "evil.com", "the host it really goes to is the one set apart")
        XCTAssertEqual(trick.lead, "https://atteo.dev@")
    }
}
