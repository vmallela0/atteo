// pixel's phone layout check (#852, #997), run against the gate server.
process.env.BASE ||= "http://localhost:8787";
await import("./pixel-checks/phone-layout.mjs");
