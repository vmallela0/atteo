// probe's pinned doc + Recap check (#989), run against the gate server.
process.env.BASE ||= "http://localhost:8787";
await import("./probe-checks/pinrecap.mjs");
