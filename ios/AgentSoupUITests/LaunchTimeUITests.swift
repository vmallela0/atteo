// Cold launch time (vedu #6612): five launches, measured by XCTest's launch metric, to compare a change against main.
// Off by default (the suite shouldn't spend half a minute on it): run it with
//   TEST_RUNNER_ATTEO_LAUNCH_METRIC=1 xcodebuild test … -only-testing:AtteoUITests/LaunchTimeUITests
// Release is the build to measure (-configuration Release ENABLE_TESTABILITY=YES); it launches signed out, so it
// times everything up to the first screen, not the network.

import XCTest

final class LaunchTimeUITests: XCTestCase {
    func testColdLaunch() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ATTEO_LAUNCH_METRIC"] == "1", "set TEST_RUNNER_ATTEO_LAUNCH_METRIC=1")
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric()], options: options) {
            XCUIApplication().launch()
        }
    }
}
