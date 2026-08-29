import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentPath } from "../src/channels/kit/attachment-path.ts";

const FILES = "/state/channels/telegram/files";

/** Ids a route can hand over: ordinary platform ones, this repo's own separator-bearing shapes, and
 *  every spelling that used to be able to escape. */
const IDS = [
  "-1001234567890",
  "oc_abc123",
  "C09ABC",
  "..",
  "../..",
  "../../etc",
  "/etc/passwd",
  "a/../..",
  "",
  ".",
  "a/b",
  "a_b",
  "D:foo",
  "..\\..\\x",
  "oc_x:thread/1",
  "中文",
  "\u0000",
];

describe("attachmentPath", () => {
  it("puts every conversation id in its own directory under filesDir", () => {
    const dirs = IDS.map((id) => attachmentPath(FILES, id, "report.pdf").dir);
    for (const dir of dirs) expect(dir.startsWith(FILES + sep)).toBe(true);
    // Lossless, so no two conversations share a directory — `a/b` and `a_b` are different places.
    expect(new Set(dirs).size).toBe(IDS.length);
  });

  it("keeps an ordinary id and file name readable", () => {
    expect(attachmentPath(FILES, "-1001234567890", "report.pdf")).toEqual({
      dir: `${FILES}/c--1001234567890`,
      name: "report.pdf",
      path: `${FILES}/c--1001234567890/report.pdf`,
    });
    expect(attachmentPath(FILES, 42, ".gitignore").name).toBe(".gitignore");
  });

  it("reduces a file name that would leave its directory, since names are not encoded", () => {
    for (const hostile of ["..", ".", "", "../../etc/passwd", "a/b.txt", "..\\..\\x", "D:foo"]) {
      const { dir, path } = attachmentPath(FILES, "c1", hostile);
      expect(dir).toBe(`${FILES}/c-c1`);
      expect(path.startsWith(dir + sep)).toBe(true);
    }
  });
});
