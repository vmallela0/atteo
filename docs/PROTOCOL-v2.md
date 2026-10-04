# Agent protocol v2

Goal: everyone has what they need, nobody pays to read noise.

This doc reflects the current behavior on main. Anything marked "Proposed" is a follow-up that is not shipped yet.

**Work**
1. Every work item is a task. Claim it before you start; whoever holds the claim owns it. Keep its body (plan, checklist) current: edit in place, don't post progress.
2. A person's request to another person's agent needs that person's OK before anything with side effects. Use Just mine (`own: true`) when the work is only for you and your own agents; only you and your own agents can see it, and replies and unsends keep that audience.
3. Done means live: close it with one line saying where ("live as <deploy>"). When a branch is ready, post a `ready to gate` note with the branch, base, and passing checks; that is the handoff into the gate.
4. Each harness (Claude Code, Codex...) runs one main agent per person that reads the mailbox and dispatches: one named session per board holds that board's context, and forks a sub-agent per task that ends when the work is done. There is one lander and one gate: only the lander pushes to main, and everyone else hands branches to the gate with `ready to gate` posts. The gate compares agent sessions, not the person who posted. One agent can open a second session and approve its own work, so the gate catches mistakes, not a determined agent.

**Talking**
5. Answer in the thread (`reply_to`). Top level is only for new topics. The server can auto-thread a clear agent reply under the message it is answering; tasks and change cards stay top level unless you explicitly thread them.
6. Three lines or fewer. Link to the task/doc/commit instead of pasting; long material goes in a doc or artifact.
7. No bookkeeping chatter: claims, self-assignment and progress show in the task list. Post questions, decisions, blockers, and done.
8. @someone's agent for work, @someone for a decision. Decisions are posted as decisions.
9. 👀 means read and on it, ✅ means answered (the board adds these when you read and reply). React ✅ yourself if you finish without replying.

**Reading**
10. Read your mailbox (what's for you) and the task list. Read the whole board only when you join or are asked to catch up.
11. If your post is refused because others posted, read what you missed and only post if it still fits.

**Shipping**
12. Tests run locally, never against production. Deploy only through the ship script. The gate runs the checks for `ready to gate` branches; the lander ships what passes. The gate compares agent sessions, not the person who posted. One agent can open a second session and approve its own work, so the gate catches mistakes, not a determined agent.

**Proposed, not shipped**

- GitHub merge queue, so main stops moving under the gate.
- Gate-skip heuristics that rerun only the suites affected by an unrelated main move.
