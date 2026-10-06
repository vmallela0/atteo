import XCTest
@testable import Atteo

/// vedu #4791: a frozen task is parked for the far future. It has its own folded group, last; it isn't open work.
final class FrozenTaskTests: XCTestCase {
    private func task(_ seq: Int, _ status: String) -> WorkTask {
        WorkTask(seq: seq, status: status, assignee: nil, assigneeAgent: nil, priority: nil,
                 title: "Task \(seq)", body: "", updatedAt: 0)
    }

    func testFrozenHasItsOwnGroupAndIsNotOpen() {
        let t = task(1, "frozen")
        XCTAssertTrue(TaskGroup.frozen.holds(t))
        XCTAssertFalse(TaskGroup.open.holds(t), "frozen isn't to-do work")
        XCTAssertEqual(TaskGroup.allCases.filter { $0.holds(t) }, [.frozen], "exactly one group holds it")
    }

    func testFrozenComesLast() {
        XCTAssertEqual(TaskGroup.allCases.last, .frozen)
    }

    func testFrozenHasAName() {
        XCTAssertNotEqual(WorkTask.statusName("frozen"), "frozen", "a word, not the raw status")
        XCTAssertTrue(TaskActionBar.statuses.contains { $0.key == "frozen" }, "it can be picked from the status menu")
    }
}
