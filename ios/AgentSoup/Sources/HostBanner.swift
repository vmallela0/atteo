import SwiftUI

/// atteo host (docs/HOST.md; vedu #4807/#4815): a member's own machine attached to a board, where agents can ask to
/// run commands that its owner approves. Very dangerous by design, so while one is online the board says so in red,
/// naming it, with Stop (the kill switch) for the machine's owner and the board's owner. Approving each command already
/// happens in the app's approvals; attaching a machine only happens from a terminal (atteo host).
struct HostInfo: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let owner: String
    let shares: [String]
    let online: Bool
    let stoppedAt: Double?
    /// Its person started it with --allow-network: commands there can reach the internet (jxn #4945).
    var network: Bool? = nil
}

struct HostsResponse: Decodable { let hosts: [HostInfo] }

/// "vedu's laptop", and "(network on)" when its commands can reach the network.
func hostLabel(_ h: HostInfo) -> String {
    "\(h.owner)'s \(h.name)" + (h.network == true ? " (" + String(localized: "network on", bundle: .l10n) + ")" : "")
}

/// Which machines the banner names: online and not stopped.
func onlineHosts(_ hosts: [HostInfo]) -> [HostInfo] { hosts.filter { $0.online && $0.stoppedAt == nil } }
/// Who may stop one: its owner, or the board's owner (the server checks again).
func canStopHost(_ h: HostInfo, me: String?, boardOwner: String?) -> Bool { me != nil && (h.owner == me || boardOwner == me) }

struct HostBanner: View {
    let board: Board
    @EnvironmentObject private var state: AppState
    @State private var hosts: [HostInfo] = []
    @State private var stopping: Set<String> = []

    var body: some View {
        let on = onlineHosts(hosts)
        VStack(spacing: 0) {
            if !on.isEmpty {
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                        Image(systemName: "exclamationmark.triangle.fill").accessibilityHidden(true)
                        Text("Machine attached").font(Typo.meta.weight(.semibold))
                    }
                    Text(String(format: String(localized: "%@: agents here can ask to run commands on it. Its owner approves each one.", bundle: .l10n),
                                on.map(hostLabel).joined(separator: ", ")))
                        .font(Typo.micro)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(on.filter { canStopHost($0, me: state.me?.owner, boardOwner: board.createdBy) }) { h in
                        Button { Task { await stop(h) } } label: {
                            Text(String(format: String(localized: "Stop %@", bundle: .l10n), h.name))
                                .font(Typo.micro.weight(.semibold))
                                .padding(.horizontal, Space.m).padding(.vertical, 6)
                                .background(Theme.onPrimary.opacity(0.18), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(stopping.contains(h.id))
                        .accessibilityIdentifier("host-stop-\(h.name)")
                    }
                }
                .foregroundStyle(Theme.onPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .background(Theme.primary)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("host-banner")
            }
        }
        .task(id: board.id) {
            // Every 20s while the board is open: a machine coming online (or being stopped elsewhere) shows up.
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(nanoseconds: 20_000_000_000)
            }
        }
    }

    private func load() async {
        guard board.encrypted != true else { return }
        if let r = try? await API.shared.get("/api/boards/\(board.id)/hosts", as: HostsResponse.self) { hosts = r.hosts }
    }

    private func stop(_ h: HostInfo) async {
        stopping.insert(h.id)
        Haptics.play(.touch)
        _ = try? await API.shared.send("/api/boards/\(board.id)/hosts/\(h.id)/stop", retries: false)
        stopping.remove(h.id)
        await load()
    }
}
