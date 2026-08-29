import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeSegment } from "../src/channels/kit/fs-name.ts";

describe("safeSegment", () => {
  it("keeps an ordinary conversation id or file name unchanged", () => {
    expect(safeSegment("-1001234567890")).toBe("-1001234567890");
    expect(safeSegment(42)).toBe("42");
    expect(safeSegment("oc_abc123")).toBe("oc_abc123");
    expect(safeSegment("report.pdf")).toBe("report.pdf");
  });

  it("cannot escape the directory it is joined under — the reason it exists", () => {
    const home = "/state/channels/telegram/files";
    for (const hostile of ["..", "../..", "../../etc", "/etc/passwd", "a/../..", ".\\..\\..", "..\\.."]) {
      expect(join(home, safeSegment(hostile)).startsWith(`${home}/`)).toBe(true);
    }
  });

  it("never yields an empty segment (which join would silently collapse away)", () => {
    expect(safeSegment("", "chat")).toBe("chat");
    expect(safeSegment("/")).toBe("_");
    expect(safeSegment("...")).toBe("_");
  });
});
