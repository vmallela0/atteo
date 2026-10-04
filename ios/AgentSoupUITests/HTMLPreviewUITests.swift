// QA for the HTML preview (jxn #2008, HTMLPreview.swift): an .html file posted to Checkout bug shows Preview beside it in
// the chat; Preview opens a sheet where the page runs (its script fills #js), can't reach the network (its fetch to
// example.com fails, so #net says "blocked"), has no cookies, storage, app bridge or popups (#acct, #pop), and a link
// to example.com goes nowhere. Full / Phone change the page's width (it prints window.innerWidth). The same file in
// Files has Preview too. Screenshots of Full and Phone also go to TEST_RUNNER_PREVIEW_SHOTS=<dir> when it's set.

import XCTest

final class HTMLPreviewUITests: AtteoUITestCase {
    /// ios/qa's preview test page, for a web view that is the top frame (no "parent page" check).
    static let page = """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Atteo preview test</title>
    <style>
      :root { --bg: #f6f1ea; --ink: #1c1b19; --accent: #c4673f; --ok: #2f7d4f; --bad: #b3261e; }
      body { margin: 0; font: 16px/1.5 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink); }
      main { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
      h1 { margin: 0 0 4px; font-size: 24px; }
      .card { background: #fff; border-radius: 12px; padding: 16px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
      button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent); color: #fff; }
      .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      .ok { color: var(--ok); } .bad { color: var(--bad); }
      canvas { width: 100%; height: 120px; background: #faf7f2; border-radius: 8px; }
    </style>
    </head>
    <body>
    <main>
      <h1>Preview test</h1>
      <p>Each card checks one thing. Green means the preview behaves as it should.</p>
      <div class="card"><b>1. Scripts run</b>
        <div class="row"><button id="count">Clicked 0 times</button><span id="js" class="bad">scripts didn't run</span></div></div>
      <div class="card"><b>2. Width (try Full / Phone)</b><p id="width">This page is ? px wide</p></div>
      <div class="card"><b>3. Network is blocked</b><p id="net">checking…</p><p><a id="go" href="https://example.com/">Go to example.com</a></p></div>
      <div class="card"><b>4. No access to your Atteo account</b><p id="acct">checking…</p><p id="pop">checking…</p></div>
      <div class="card"><b>5. Drawing</b><canvas id="c" width="600" height="120"></canvas></div>
    </main>
    <script>
      document.getElementById('js').textContent = 'scripts run';
      document.getElementById('js').className = 'ok';
      let n = 0;
      const b = document.getElementById('count');
      b.onclick = () => { n++; b.textContent = 'Clicked ' + n + ' time' + (n === 1 ? '' : 's'); };
      const w = () => { document.getElementById('width').textContent = 'This page is ' + window.innerWidth + ' px wide'; };
      w(); addEventListener('resize', w);
      const c = document.getElementById('c'), g = c.getContext('2d');
      g.strokeStyle = '#c4673f'; g.lineWidth = 3; g.beginPath();
      for (let x = 0; x <= c.width; x += 4) g.lineTo(x, 60 + 40 * Math.sin(x / 40));
      g.stroke();
      const net = document.getElementById('net');
      fetch('https://example.com/', { mode: 'no-cors' })
        .then(() => { net.textContent = 'reached the network (should be blocked)'; net.className = 'bad'; })
        .catch(() => { net.textContent = 'blocked, as it should be'; net.className = 'ok'; });
      const acct = document.getElementById('acct');
      let leaked = false;
      try { leaked = !!document.cookie || !!localStorage.length; } catch { leaked = false; }
      if (window.webkit && window.webkit.messageHandlers && Object.keys(window.webkit.messageHandlers).length) leaked = true;
      if (typeof RTCPeerConnection !== 'undefined') leaked = true;
      acct.textContent = leaked ? 'can see cookies, storage, the app or WebRTC (should not)' : 'no cookies, storage, app bridge or WebRTC, as it should be';
      acct.className = leaked ? 'bad' : 'ok';
      const pop = document.getElementById('pop');
      let win = null;
      try { win = window.open('https://example.com/'); } catch { win = null; }
      pop.textContent = win ? 'opened a window (should not)' : 'no popups, as it should be';
      pop.className = win ? 'bad' : 'ok';
    </script>
    </body>
    </html>
    """

    var shotsDir: String { env["PREVIEW_SHOTS"] ?? "" }

    func save(_ name: String) {
        shot(name)
        guard !shotsDir.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: shotsDir, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: shotsDir).appendingPathComponent("\(name).png"))
    }

    /// Text in the page (WKWebView shows it as static texts or other elements, depending on the tag).
    func inPage(_ a: XCUIApplication, _ format: String, _ args: CVarArg...) -> XCUIElement {
        a.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: format, argumentArray: args)).firstMatch
    }

    func testPreviewRunsSandboxed() throws {
        continueAfterFailure = false
        guard let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded Checkout bug board") }
        let name = "preview-\(Int(Date().timeIntervalSince1970) % 100000).html"
        let up = call("POST", "/api/boards/\(b)/upload?name=\(name)", data: Data(Self.page.utf8), contentType: "text/html")
        XCTAssertEqual(up["_status"] as? Int, 201, "uploaded: \(up)")

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        // In the chat: the file, with Preview beside it.
        let chip = a.buttons.matching(NSPredicate(format: "identifier == 'chat-file' AND label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "the file is in the chat")
        let previews = a.buttons.matching(identifier: "file-preview")
        XCTAssertTrue(previews.firstMatch.waitForExistence(timeout: 5), "Preview is offered")
        let preview = try XCTUnwrap(previews.allElementsBoundByIndex.min { abs($0.frame.midY - chip.frame.midY) < abs($1.frame.midY - chip.frame.midY) })
        XCTAssertLessThan(abs(preview.frame.midY - chip.frame.midY), 20, "beside this file")
        save("preview-00-chat")
        preview.tap()

        // The sheet: the page runs, offline, with nothing of yours.
        let any = a.descendants(matching: .any)
        XCTAssertTrue(any["preview-sheet"].firstMatch.waitForExistence(timeout: 10), "the preview sheet")
        XCTAssertTrue(a.staticTexts[name].exists, "named")
        let note = any["preview-note"].firstMatch; XCTAssertTrue(note.label.contains("Runs in a sandbox"), "the sandbox note: \(note.debugDescription)")
        XCTAssertTrue(inPage(a, "label == 'scripts run'").waitForExistence(timeout: 15), "scripts run")
        XCTAssertTrue(inPage(a, "label CONTAINS 'blocked, as it should be'").waitForExistence(timeout: 15), "the fetch to example.com is blocked")
        XCTAssertFalse(inPage(a, "label CONTAINS 'reached the network'").exists)
        XCTAssertTrue(inPage(a, "label CONTAINS 'no cookies, storage, app bridge or WebRTC'").exists, "nothing of the account, no bridge, no WebRTC")
        XCTAssertTrue(inPage(a, "label CONTAINS 'no popups'").exists, "window.open gives nothing")

        // Full, then Phone (390 wide), then Full again.
        let full = a.buttons["preview-width-full"], phone = a.buttons["preview-width-phone"]
        XCTAssertTrue(full.exists && phone.exists, "Full / Phone")
        XCTAssertTrue(full.isSelected, "Full to start")
        let fullWidth = inPage(a, "label BEGINSWITH 'This page is '")
        XCTAssertTrue(fullWidth.waitForExistence(timeout: 5))
        let fullLabel = fullWidth.label
        XCTAssertFalse(fullLabel.contains(" 390 "), "full width isn't the phone's: \(fullLabel)")
        sleep(1)
        save("preview-01-full")
        phone.tap()
        XCTAssertTrue(inPage(a, "label == 'This page is 390 px wide'").waitForExistence(timeout: 5), "Phone: 390 px")
        XCTAssertTrue(phone.isSelected)
        sleep(1)
        save("preview-02-phone")
        full.tap()
        XCTAssertTrue(eventually(full, "isSelected == true", timeout: 3), "Full again")
        let back = inPage(a, "label BEGINSWITH 'This page is '")
        XCTAssertTrue(eventually(back, "label == %@".replacingOccurrences(of: "%@", with: "'\(fullLabel)'"), timeout: 8), "back to full width: \(back.label), wanted \(fullLabel)")

        // A link out goes nowhere: the page stays.
        inPage(a, "label == 'Go to example.com'").tap()
        sleep(2)
        XCTAssertTrue(inPage(a, "label == 'scripts run'").exists, "still the page after tapping a link out")
        XCTAssertTrue(any["preview-sheet"].firstMatch.exists)

        // Close.
        a.buttons["preview-close"].tap()
        XCTAssertTrue(eventually(any["preview-sheet"].firstMatch, "exists == false"), "closed")
        XCTAssertTrue(composer(a).exists, "back in the chat")

        // Files: the same file has Preview.
        a.buttons["work-strip"].tap()
        let files = a.buttons["Files"]
        XCTAssertTrue(files.waitForExistence(timeout: 5))
        files.tap()
        let row = any["file-\(name)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "in Files")
        let rowPreview = try XCTUnwrap(a.buttons.matching(identifier: "file-preview").allElementsBoundByIndex.min { abs($0.frame.midY - row.frame.midY) < abs($1.frame.midY - row.frame.midY) })
        XCTAssertLessThan(abs(rowPreview.frame.midY - row.frame.midY), 20, "beside it")
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier == 'file-preview' AND label == 'Preview'")).firstMatch.exists, "says Preview")
        save("preview-03-files")
        rowPreview.tap()
        XCTAssertTrue(any["preview-sheet"].firstMatch.waitForExistence(timeout: 10), "the preview, from Files")
        XCTAssertTrue(inPage(a, "label == 'scripts run'").waitForExistence(timeout: 15), "running")
        a.buttons["preview-close"].tap()
        XCTAssertTrue(eventually(any["preview-sheet"].firstMatch, "exists == false"), "closed")
        XCTAssertTrue(row.exists, "back on Files")

        // Board info's files: Preview runs it too (the row itself still opens the source).
        a.buttons["Done"].tap()
        XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 5))
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5), "Info")
        let infoRow = any["file-\(name)"].firstMatch
        for _ in 0..<6 where !infoRow.exists || !infoRow.isHittable { a.swipeUp(); sleep(1) }
        XCTAssertTrue(infoRow.waitForExistence(timeout: 5), "in Info's files")
        let infoPreview = try XCTUnwrap(a.buttons.matching(identifier: "file-preview").allElementsBoundByIndex.min { abs($0.frame.midY - infoRow.frame.midY) < abs($1.frame.midY - infoRow.frame.midY) })
        XCTAssertLessThan(abs(infoPreview.frame.midY - infoRow.frame.midY), 20, "beside it")
        save("preview-04-info")
        infoPreview.tap()
        XCTAssertTrue(any["preview-sheet"].firstMatch.waitForExistence(timeout: 10), "the preview, from Info")
        XCTAssertTrue(inPage(a, "label == 'scripts run'").waitForExistence(timeout: 15), "running")
        a.buttons["preview-close"].tap()
        XCTAssertTrue(eventually(any["preview-sheet"].firstMatch, "exists == false"), "closed")
        XCTAssertTrue(a.navigationBars["Info"].exists, "still on Info, not the file's source")
    }
}
