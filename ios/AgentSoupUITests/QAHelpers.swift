// Shared harness for the newer UI test files: launching the app against the local server ios/qa/seed.mjs filled,
// screenshots, and calls to that server as maya (the app's token) or as theo from his phone (OTHER_APP, a person), so a
// test can make something happen "from someone else" and watch the app follow live.

import UIKit
import XCTest

class AtteoUITestCase: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var otherApp: String { env["AGENT_SOUP_OTHER_APP"] ?? "" }
    var mayaApp: String { env["AGENT_SOUP_TOKEN"] ?? "" }

    func app(fresh: Bool = true, extra: [String: String] = [:]) -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_SERVER"] = env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788"
        a.launchEnvironment["AGENT_SOUP_TOKEN"] = mayaApp
        if fresh { a.launchEnvironment["AGENT_SOUP_FRESH"] = "1" }
        for (k, v) in extra { a.launchEnvironment[k] = v }
        return a
    }

    func shot(_ name: String) {
        let s = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    /// A call to the local server, waited for: JSON in (`json`) or raw bytes (`data`), JSON out. As maya unless `token`.
    @discardableResult
    func call(_ method: String, _ path: String, json: [String: Any]? = nil, data: Data? = nil, contentType: String? = nil, token: String? = nil) -> [String: Any] {
        guard let server = env["AGENT_SOUP_SERVER"], let url = URL(string: server + path) else { return [:] }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token ?? mayaApp)", forHTTPHeaderField: "authorization")
        if let json { r.httpBody = try? JSONSerialization.data(withJSONObject: json); r.setValue("application/json", forHTTPHeaderField: "content-type") }
        if let data { r.httpBody = data; r.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "content-type") }
        var out: [String: Any] = [:]
        let done = expectation(description: "\(method) \(path)")
        URLSession.shared.dataTask(with: r) { d, resp, _ in
            out = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            out["_status"] = (resp as? HTTPURLResponse)?.statusCode ?? 0
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        return out
    }

    /// maya's newest board with this title that isn't archived (seeding again archives the older copies).
    func boardId(titled title: String) -> String? {
        let boards = call("GET", "/api/me/boards")["boards"] as? [[String: Any]] ?? []
        return boards.filter { $0["title"] as? String == title && $0["archived"] as? Bool != true }
            .max { ($0["last_activity"] as? Double ?? 0) < ($1["last_activity"] as? Double ?? 0) }?["id"] as? String
    }

    /// Chats, on Boards (whatever the last run left selected), then the chat with this title.
    func openChat(_ a: XCUIApplication, _ title: String, direct: Bool = false) {
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        let tab = a.buttons[direct ? "tab-direct" : "tab-boards"]
        if tab.waitForExistence(timeout: 10) { tab.tap() }
        let row = a.buttons["chat-\(title)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "\(title) is in the list")
        row.tap()
        XCTAssertTrue(composer(a).waitForExistence(timeout: 10), "\(title) opens")
    }

    func composer(_ a: XCUIApplication, _ id: String = "composer") -> XCUIElement {
        a.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND (elementType == %d OR elementType == %d)", id,
                                                           XCUIElement.ElementType.textView.rawValue, XCUIElement.ElementType.textField.rawValue)).firstMatch
    }

    /// Waits until `element` matches `format` (or `timeout` passes); true if it did.
    @discardableResult
    func eventually(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 8) -> Bool {
        XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)], timeout: timeout) == .completed
    }
}
