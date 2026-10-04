// The web's features in the app (#508): act on tasks (claim, status, tick, add, remove), decide approvals with a
// note, find people and start a DM, invite people to a board, read its files, make / rename / archive boards.
// Kept apart from AppState.swift so the two merge cleanly. Task changes are optimistic: the screen changes first and
// rolls back (saying why) if the server says no.

import Foundation
import SwiftUI

extension Notification.Name {
    /// A board you archived from the app: Chats closes it (it's read-only now) and drops it from the list.
    static let boardArchived = Notification.Name("atteo.boardArchived")
}

extension AppState {
    // MARK: - Tasks

    /// A board's tasks by id (the task screens only know the board's id).
    func loadTasks(id: String) async {
        do {
            let r = try await API.shared.get("/api/boards/\(id)/tasks", as: TasksResponse.self)
            if r.tasks != tasks[id] { withAnimation(.smooth) { tasks[id] = r.tasks } }
        } catch { report(error, quiet: true) }
    }

    private func change(_ board: String, _ seq: Int, _ edit: (inout WorkTask) -> Void) {
        withAnimation(.smooth) { tasks[board] = (tasks[board] ?? []).map { t in var t = t; if t.seq == seq { edit(&t) }; return t } }
    }

    /// One action on a task: the change shows at once; the server's answer replaces it (or the old one comes back).
    @discardableResult
    private func act(_ board: String, _ seq: Int, _ body: [String: Any], optimistic: (inout WorkTask) -> Void) async -> Bool {
        let before = tasks[board]
        change(board, seq, optimistic)
        do {
            let d = try await API.shared.send("/api/boards/\(board)/tasks/\(seq)", body: body)
            if let t = try? JSONDecoder.soup.decode(TaskResponse.self, from: d).task { change(board, seq) { $0 = t } }
            Task { await loadTasks(id: board) } // a done can tick a parent too
            return true
        } catch {
            withAnimation(.smooth) { tasks[board] = before }
            Haptics.play(.failed)
            report(error)
            return false
        }
    }

    /// Whether you hold a task right now (you, not your agent).
    func holding(_ t: WorkTask) -> Bool {
        guard let me = me?.owner else { return false }
        return t.leaseHolder == me && t.leaseAgent != true && (t.leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000
    }

    func claim(_ board: String, _ t: WorkTask) async {
        guard let me = self.me?.owner else { return }
        Haptics.play(.touch)
        await act(board, t.seq, ["action": "claim", "minutes": 60]) {
            $0.leaseHolder = me
            $0.leaseAgent = false
            $0.leaseUntil = Date().timeIntervalSince1970 * 1000 + 3_600_000
            if $0.status == "todo" || $0.status == "stopped" { $0.status = "doing" }
            $0.updatedAt = Date().timeIntervalSince1970 * 1000
        }
    }

    func release(_ board: String, _ t: WorkTask) async {
        Haptics.play(.touch)
        await act(board, t.seq, ["action": "release"]) {
            $0.leaseHolder = nil
            $0.leaseAgent = nil
            $0.leaseUntil = nil
            if $0.status == "doing" { $0.status = "todo" }
            $0.updatedAt = Date().timeIntervalSince1970 * 1000
        }
    }

    func setStatus(_ board: String, _ t: WorkTask, _ status: String) async {
        guard status != t.status else { return }
        Haptics.play(status == "done" ? .completed : .touch)
        await act(board, t.seq, ["action": "update", "status": status]) { $0.status = status; $0.updatedAt = Date().timeIntervalSince1970 * 1000 }
    }

    /// Ticks (or unticks) one checklist line: a versioned edit of just that line, so an agent ticking another line at
    /// the same moment is fine. If the line isn't unique in the body, the whole body goes with the version it started from.
    func toggle(_ board: String, _ t: WorkTask, line: Int) async {
        var lines = t.body.components(separatedBy: "\n")
        guard lines.indices.contains(line) else { return }
        let raw = lines[line]
        let done = raw.range(of: #"\[[xX]\]"#, options: .regularExpression) != nil
        guard let box = raw.range(of: done ? #"\[[xX]\]"# : #"\[ \]"#, options: .regularExpression) else { return }
        let flipped = raw.replacingCharacters(in: box, with: done ? "[ ]" : "[x]")
        lines[line] = flipped
        let what = String(raw.drop { $0 != "]" }.dropFirst().trimmingCharacters(in: .whitespaces).prefix(80))
        let summary = (done ? "unticked: " : "ticked: ") + what
        // A tick is a selection; the tick that finishes the checklist is the task completing.
        let finishes = !done && (t.checklist.map { $0.done + 1 == $0.total } ?? false)
        Haptics.play(finishes ? .completed : .ticked)
        let before = tasks[board]
        change(board, t.seq) { $0.body = lines.joined(separator: "\n") }
        do {
            do {
                _ = try await API.shared.send("/api/boards/\(board)/tasks/\(t.seq)", body: ["action": "edit", "old_str": raw, "new_str": flipped, "summary": summary])
            } catch APIError.server(let m) where m.contains("more than once") {
                // The same line twice: send the whole body, from the version on the server.
                let fresh = try await API.shared.get("/api/boards/\(board)/tasks/\(t.seq)", as: TaskResponse.self).task
                var fl = fresh.body.components(separatedBy: "\n")
                guard fl.indices.contains(line), fl[line] == raw else { throw APIError.server("That box has changed. Try again.") }
                fl[line] = flipped
                _ = try await API.shared.send("/api/boards/\(board)/tasks/\(t.seq)", body: ["action": "edit", "body": fl.joined(separator: "\n"), "base_version": fresh.version ?? 0, "summary": summary])
            }
            await loadTasks(id: board)
        } catch {
            withAnimation(.smooth) { tasks[board] = before }
            Haptics.play(.failed)
            report(error)
        }
    }

    /// A new task (a title, and optionally a checklist): it shows in the list as soon as the server has it.
    func createTask(_ board: String, title: String, checklist: [String]) async -> WorkTask? {
        let items = checklist.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let body = items.map { "- [ ] \($0)" }.joined(separator: "\n")
        do {
            let d = try await API.shared.send("/api/boards/\(board)/tasks", body: ["title": title, "body": body])
            let t = try JSONDecoder.soup.decode(TaskResponse.self, from: d).task
            withAnimation(.smooth) { tasks[board] = (tasks[board] ?? []).filter { $0.seq != t.seq } + [t] }
            Haptics.play(.completed)
            Task { await loadTasks(id: board) }
            return t
        } catch { report(error); return nil }
    }

    /// Whether you can remove a task: you posted it, or you made the board (the server's rule for retracting).
    func canRemove(_ t: WorkTask, board: String) -> Bool {
        guard let me = me?.owner else { return false }
        return t.author == me || boards.first(where: { $0.id == board })?.createdBy == me
    }

    /// Removes a task from the board (retracts the message that posted it). Gone at once; back if the server says no.
    func removeTask(_ board: String, _ t: WorkTask) async -> Bool {
        let before = tasks[board]
        withAnimation(.smooth) { tasks[board] = (tasks[board] ?? []).filter { $0.seq != t.seq } }
        do {
            try await API.shared.send("/api/boards/\(board)/entries/\(t.seq)/retract", body: ["reason": "Removed \"\(t.title)\" from the task board."])
            Haptics.play(.completed)
            await loadTasks(id: board)
            return true
        } catch {
            withAnimation(.smooth) { tasks[board] = before }
            report(error)
            return false
        }
    }

    // MARK: - Approvals

    /// Approve or decline with a note your agent reads.
    func decide(_ a: Approval, approve: Bool, note: String) async -> Bool {
        do {
            try await API.shared.send("/api/approvals/\(a.id)/\(approve ? "approve" : "reject")", body: ["note": note], retries: false)
            withAnimation(.smooth) { approvals.removeAll { $0.id == a.id } }
            Haptics.play(approve ? .approved : .denied)
            Notifier.shared.askIfSensible()
            return true
        } catch { report(error); await refreshInbox(); return false }
    }

    // MARK: - People

    func searchPeople(_ q: String) async -> [Person] {
        let q = q.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return [] }
        do { return try await API.shared.get("/api/people?q=\(enc)", as: PeopleResponse.self).people.filter { $0.relation != "self" } } catch { report(error, quiet: true); return [] }
    }

    func friends() async -> [Person] {
        do { return try await API.shared.get("/api/friends", as: FriendsResponse.self).friends } catch { report(error, quiet: true); return [] }
    }

    func person(_ name: String) async -> PersonResponse? {
        try? await API.shared.get("/api/people/\(name)", as: PersonResponse.self)
    }

    /// Asks to be friends (or accepts, if they asked first). Returns the new relation.
    func befriend(_ name: String) async -> String? {
        struct R: Decodable { let relation: String? }
        do {
            let d = try await API.shared.send("/api/friends/request", body: ["user": name])
            Haptics.play(.completed)
            return (try? JSONDecoder.soup.decode(R.self, from: d))?.relation ?? "pending_out"
        } catch { report(error); return nil }
    }

    func block(_ name: String) async -> Bool {
        do { try await API.shared.send("/api/friends/\(name)/block"); Haptics.play(.warning); return true } catch { report(error); return false }
    }

    /// Your DM with a friend (made the first time), ready to open.
    func openDirect(_ name: String) async -> Board? {
        do {
            let d = try await API.shared.send("/api/direct/\(name)")
            let r = try JSONDecoder.soup.decode(DirectResponse.self, from: d)
            await refreshBoards()
            return boards.first { $0.id == r.board } ?? Board(id: r.board, title: r.title, kind: "direct", entryCount: 0, lastActivity: Date().timeIntervalSince1970 * 1000, encrypted: false, last: nil)
        } catch { report(error); return nil }
    }

    // MARK: - Boards: members, invites, rename, archive, new

    func boardMembers(_ board: String) async -> BoardMembersResponse? {
        do { return try await API.shared.get("/api/boards/\(board)/members", as: BoardMembersResponse.self) } catch { report(error, quiet: true); return nil }
    }

    /// Invites a friend (by name) or anyone (by email). Returns what happened, in words.
    func invite(_ board: String, _ to: String) async -> String? {
        do {
            let d = try await API.shared.send("/api/boards/\(board)/invites", body: ["to": to.trimmingCharacters(in: .whitespaces)], retries: false)
            Haptics.play(.completed)
            return (try? JSONDecoder.soup.decode(InviteResponse.self, from: d))?.message ?? "Invited \(to)."
        } catch { report(error); return nil }
    }

    /// A link anyone with an account can use to join (can post, valid 7 days).
    func inviteLink(_ board: String) async -> URL? {
        do {
            let d = try await API.shared.send("/api/boards/\(board)/links", body: ["role": "contributor", "link_days": 7], retries: false)
            return URL(string: try JSONDecoder.soup.decode(InviteLinkResponse.self, from: d).url)
        } catch { report(error); return nil }
    }

    func renameBoard(_ board: String, to title: String) async -> Bool {
        do {
            try await API.shared.send("/api/boards/\(board)/rename", body: ["title": title], retries: false)
            await refreshBoards()
            return true
        } catch { report(error); return false }
    }

    func archiveBoard(_ board: String) async -> Bool {
        do {
            try await API.shared.send("/api/boards/\(board)/archive", body: ["archived": true], retries: false)
            Haptics.play(.completed)
            NotificationCenter.default.post(name: .boardArchived, object: board)
            await refreshBoards()
            return true
        } catch { report(error); return false }
    }

    /// A new board (end-to-end encrypted unless you turn it off), ready to open.
    func createBoard(title: String, encrypted: Bool) async -> Board? {
        do {
            let d = try await API.shared.send("/api/boards", body: ["title": title, "encrypted": encrypted], retries: false)
            let r = try JSONDecoder.soup.decode(NewBoardResponse.self, from: d)
            Haptics.play(.completed)
            await refreshBoards()
            return boards.first { $0.id == r.board.id } ?? Board(id: r.board.id, title: r.board.title, kind: "board", entryCount: 0, lastActivity: Date().timeIntervalSince1970 * 1000, encrypted: encrypted, last: nil, createdBy: me?.owner)
        } catch { report(error); return nil }
    }

    // MARK: - Files

    func docs(_ board: String) async -> [DocMeta] {
        do { return try await API.shared.get("/api/boards/\(board)/files", as: DocsResponse.self).docs } catch { report(error, quiet: true); return [] }
    }

    func doc(_ board: String, _ name: String, version: Int?) async -> Doc? {
        let n = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? name
        do { return try await API.shared.get("/api/boards/\(board)/doc?name=\(n)\(version.map { "&version=\($0)" } ?? "")", as: Doc.self) } catch { report(error); return nil }
    }

    func docHistory(_ board: String, _ name: String) async -> [DocVersion] {
        let n = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))) ?? name
        do { return try await API.shared.get("/api/boards/\(board)/doc-history?name=\(n)", as: DocHistoryResponse.self).versions } catch { report(error, quiet: true); return [] }
    }
}
