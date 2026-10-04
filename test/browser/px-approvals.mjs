// pixel's approvals check (#1010), run against the gate server.
process.env.BASE ||= "http://localhost:8787";
await import("./pixel-checks/approvals.mjs");
