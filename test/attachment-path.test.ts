import { describe, expect, it } from "vitest";
import { attachmentPath } from "../src/channels/kit/attachment-path.ts";

const FILES = "/state/channels/telegram/files";

describe("attachmentPath", () => {
  it("keeps an ordinary conversation id and file name intact", () => {
    expect(attachmentPath(FILES, "-1001234567890", "report.pdf")).toEqual({
      dir: `${FILES}/-1001234567890`,
      name: "report.pdf",
      path: `${FILES}/-1001234567890/report.pdf`,
    });
    expect(attachmentPath(FILES, 42, ".gitignore").name).toBe(".gitignore");
  });

  it("refuses a route that does not name a directory inside filesDir — audibly, not by folding it", () => {
    for (const hostile of ["..", "../..", "../../etc", "/etc/passwd", "a/../..", "", "."]) {
      expect(() => attachmentPath(FILES, hostile, "x.pdf")).toThrow(/not inside/);
    }
  });

  it("reduces a hostile file name to a usable one, and never leaves its own directory", () => {
    // `D:foo` is here for the same reason as the rest: on Windows `resolve` sends it to another
    // drive's cwd, and the proof catches it without the spelling being listed.
    for (const hostile of ["..", ".", "", "../../etc/passwd", "a/b.txt", "..\\..\\x", "D:foo"]) {
      const { dir, path } = attachmentPath(FILES, "c1", hostile);
      expect(dir).toBe(`${FILES}/c1`);
      expect(path.startsWith(`${dir}/`)).toBe(true);
    }
  });
});
