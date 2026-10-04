// Opening a provider (vedu #2298): its installed app through a universal link, else its website; never our link or a
// message in the URL (they go on the clipboard).

import XCTest
@testable import Atteo

@MainActor
final class AppOpenerTests: XCTestCase {
    /// Records each open; `installed` says whether an app takes a universal link.
    private func run(_ link: ProviderLink, installed: Bool) -> [(URL, Bool)] {
        var calls: [(URL, Bool)] = []
        AppOpener.open(link) { url, appOnly, done in
            calls.append((url, appOnly))
            done(appOnly ? installed : true)
        }
        return calls
    }

    func testAppInstalledOpensOnlyTheApp() {
        let calls = run(AssistantProvider.grok.chat!, installed: true)
        XCTAssertEqual(calls.map(\.0.absoluteString), ["https://grok.com"])
        XCTAssertEqual(calls.map(\.1), [true], "a universal link only")
    }

    func testNoAppFallsBackToTheWeb() {
        let calls = run(AssistantProvider.chatgpt.chat!, installed: false)
        XCTAssertEqual(calls.map(\.0.absoluteString), ["https://chatgpt.com/open-app", "https://chatgpt.com"])
        XCTAssertEqual(calls.map(\.1), [true, false])
    }

    func testNoAppLinkGoesStraightToTheWeb() {
        let calls = run(AssistantProvider.chatgpt.page!.link, installed: true)
        XCTAssertEqual(calls.map(\.0.absoluteString), ["https://chatgpt.com/#settings/Connectors"])
        XCTAssertEqual(calls.map(\.1), [false])
    }

    func testEachProviderHasAnAppAndAWeb() {
        XCTAssertEqual(AssistantProvider.muse.chat, ProviderLink(app: "https://muse.ai/chat", web: "https://muse.ai"))
        XCTAssertEqual(AssistantProvider.claude.chat?.app?.absoluteString, "https://claude.ai/new")
        XCTAssertEqual(AssistantProvider.claude.page?.link.app?.absoluteString, "https://claude.ai/customize/connectors?modal=add-custom-connector")
        XCTAssertEqual(AssistantProvider.grok.page?.link.app?.absoluteString, "https://grok.com/connectors")
        XCTAssertNil(AssistantProvider.coding.chat, "a terminal: nothing to open")
        XCTAssertNil(AssistantProvider.muse.page, "Muse has no connectors page to paste a link in")
    }

    /// Muse's Connect opens our key page on atteo.dev (vedu #2290), never the workers.dev host, with nothing secret in it.
    func testMuseConnectPageIsOurKeyPage() {
        let page = AssistantProvider.museConnectPage
        XCTAssertEqual(page, API.shared.publicBase.appendingPathComponent("connect/muse"))
        XCTAssertEqual(page?.path(), "/connect/muse")
        XCTAssertNotEqual(page?.host(), "agent-board.vedu-mallela.workers.dev")
        if API.shared.base.host() == "agent-board.vedu-mallela.workers.dev" {
            XCTAssertEqual(page?.absoluteString, "https://atteo.dev/connect/muse")
        }
        XCTAssertNil(page?.query(), "no key or token rides in the URL")
    }

    /// Nothing of ours rides in a provider URL: every one is https on the provider's own host, without our MCP link.
    func testNoSecretsInProviderURLs() {
        let hosts = ["grok.com", "chatgpt.com", "claude.ai", "muse.ai"]
        for p in AssistantProvider.allCases {
            for link in [p.chat, p.page?.link].compactMap({ $0 }) {
                for u in [link.app, link.web].compactMap({ $0 }) {
                    XCTAssertEqual(u.scheme, "https", u.absoluteString)
                    XCTAssertTrue(hosts.contains(u.host() ?? ""), u.absoluteString)
                    XCTAssertFalse(u.absoluteString.contains("mcp"), u.absoluteString)
                }
            }
        }
    }
}
