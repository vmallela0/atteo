import { describe, expect, it } from "vitest";
import { boardIdIn } from "../cli/src/boardid";

// atteo join / use / create and the MCP channel's follow read the board id from the tool's first line (#1949, #2156).
describe("boardIdIn", () => {
  it("reads every shape of the join and create replies", () => {
    expect(boardIdIn('Joined "My board" (b_abc123def).')).toBe("b_abc123def");
    expect(boardIdIn('Accepted vedu\'s invitation and joined "T" (b_abc123def)')).toBe("b_abc123def");
    expect(boardIdIn("Joined b_abc123def. Read it for the board's name and summary.")).toBe("b_abc123def");
    expect(boardIdIn("Accepted vedu's invitation and joined b_abc123def")).toBe("b_abc123def");
  });
  it("can't be redirected by a title that contains another board id", () => {
    expect(boardIdIn('Joined "x (b_evilevil1)" (b_abc123def)')).toBe("b_abc123def");
  });
  it("finds nothing when there's no board id", () => {
    expect(boardIdIn("No board called that.")).toBeUndefined();
  });
});
