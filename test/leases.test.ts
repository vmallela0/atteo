import { describe, expect, it } from "vitest";
import { LEASE_CAP_MS, renewedUntil } from "../src/leases";

const M = 60_000;
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

describe("renewedUntil", () => {
  const lease = { until: T0 + 30 * M, mins: 30, cap: T0 + LEASE_CAP_MS };

  it("moves a live lease to now + its minutes", () => {
    expect(renewedUntil(lease, T0 + 10 * M)).toBe(T0 + 40 * M);
  });

  it("never past the cap, and not at all once there", () => {
    expect(renewedUntil({ ...lease, until: T0 + LEASE_CAP_MS - 5 * M }, T0 + LEASE_CAP_MS - 10 * M)).toBe(T0 + LEASE_CAP_MS);
    expect(renewedUntil({ ...lease, until: T0 + LEASE_CAP_MS }, T0 + LEASE_CAP_MS - M)).toBeNull();
  });

  it("an expired lease never comes back (a session that went quiet loses it)", () => {
    expect(renewedUntil(lease, T0 + 30 * M)).toBeNull();
    expect(renewedUntil(lease, T0 + 31 * M)).toBeNull();
  });

  it("only renewing leases (an agent session's): a person's claim has no minutes or cap", () => {
    expect(renewedUntil({ ...lease, mins: null, cap: null }, T0 + M)).toBeNull();
    expect(renewedUntil({ until: null, mins: 30, cap: T0 + LEASE_CAP_MS }, T0 + M)).toBeNull();
  });

  it("doesn't shorten: right after a claim it stays as it is", () => {
    expect(renewedUntil(lease, T0)).toBeNull();
  });
});
