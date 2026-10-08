import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAG_GATE_JS } from "../src/dragGate";
import { BOARD_JS } from "../src/html";

type Gate = { hold(): () => void; ask(): boolean; defer(): void; readonly busy: boolean };
const dragGate = new Function(`${DRAG_GATE_JS};return dragGate`)() as (run: () => void, ms?: number) => Gate;

describe("task board drag gate: reloads wait out a drag, then run once", () => {
  afterEach(() => vi.useRealTimers());

  it("reloads at once when nothing is being dragged", () => {
    const run = vi.fn(), g = dragGate(run);
    expect(g.ask()).toBe(true);
    expect(g.busy).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("queues reloads during a drag and coalesces them into one when it ends", () => {
    const run = vi.fn(), g = dragGate(run);
    const release = g.hold();
    expect(g.busy).toBe(true);
    expect(g.ask()).toBe(false);
    expect(g.ask()).toBe(false);
    g.defer(); // a reload already in flight that answered mid-drag
    expect(run).not.toHaveBeenCalled();
    release();
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.busy).toBe(false);
    release(); // released twice (dragend after a drop): still once, and the count can't go below zero
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.busy).toBe(false);
    expect(g.ask()).toBe(true);
  });

  it("a drag with nothing asked ends without a reload", () => {
    const run = vi.fn(), g = dragGate(run);
    g.hold()();
    expect(run).not.toHaveBeenCalled();
  });

  it("a drop still saving doesn't end a newer drag: the reload waits for both", () => {
    const run = vi.fn(), g = dragGate(run);
    const saving = g.hold(); // the first drag, dropped, its move not saved yet
    g.ask();
    const second = g.hold(); // the next drag starts
    saving(); // the first move is saved
    expect(run).not.toHaveBeenCalled();
    expect(g.busy).toBe(true);
    second();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a hold that's never released lets go after the timeout and reloads", () => {
    vi.useFakeTimers();
    const run = vi.fn(), g = dragGate(run, 1000);
    const release = g.hold();
    g.ask();
    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(g.busy).toBe(false);
    release(); // a late release does nothing
    expect(g.busy).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("each hold has its own timeout", () => {
    vi.useFakeTimers();
    const run = vi.fn(), g = dragGate(run, 1000);
    g.hold()();
    vi.advanceTimersByTime(800);
    g.hold();
    g.ask();
    vi.advanceTimersByTime(800);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ships in the board script, wired to the task board", () => {
    expect(BOARD_JS).toContain("function dragGate(");
    expect(BOARD_JS).toContain("const kGate=dragGate(");
    expect(BOARD_JS).toMatch(/dragstart[^\n]*kRelease=kGate\.hold\(\)/);
    expect(BOARD_JS).toMatch(/dragend[^\n]*kRelease\?\.\(\)/);
    expect(BOARD_JS).toMatch(/async function loadTasks\(\)\{if\(!kGate\.ask\(\)\)return/);
  });
});
