// Automatic reading must not take the audio session from a call (vedu #5607). Hushing once isn't enough: another
// message can arrive under the call sheet. Each call holds a pause until it ends, including Talk's standby.

import Foundation

struct ReadAloudGate {
    private var callers: Set<UUID> = []
    var allowed: Bool { callers.isEmpty }

    mutating func suspend(_ caller: UUID) { callers.insert(caller) }
    mutating func resume(_ caller: UUID) { callers.remove(caller) }
}
