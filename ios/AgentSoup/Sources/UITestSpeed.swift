// UI tests run faster with animations off (vedu #2790). Debug builds launched by the UI tests (AGENT_SOUP_STILL, which
// QAHelpers and every test's app() set) turn off UIKit animations and run Core Animation fast, so XCTest stops waiting
// for transitions, springs and fades to settle before each query. Release builds never do any of this.

import UIKit

enum UITestSpeed {
    /// True in a debug build started by the UI tests.
    static var on: Bool {
        #if DEBUG
        API.environment("STILL") != nil
        #else
        false
        #endif
    }

    /// Call once at launch: animations off now, and every window that becomes key runs its layers fast.
    static func apply() {
        guard on else { return }
        UIView.setAnimationsEnabled(false)
        NotificationCenter.default.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { note in
            (note.object as? UIWindow)?.layer.speed = 20
        }
    }
}
