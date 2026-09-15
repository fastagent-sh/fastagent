/**
 * `files/` is the one part of a channel's state home that nothing ever asks for back, so it is the one part that is
 * `/tmp`: emptied when the process comes up. Everything else in the home is the channel's memory and must survive.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mountStateHome } from "../src/channels/kit/state.ts";
import { attachmentPath } from "../src/channels/kit/attachment-path.ts";

it("clears the inbound attachments at mount and keeps the rest of the state home", () => {
  const home = join(mkdtempSync(join(tmpdir(), "fa-state-home-")), "channels", "telegram");
  mkdirSync(home, { recursive: true });
  const turns = join(home, "turns.json");
  writeFileSync(turns, "[]");
  // Written where the channel actually writes it, so the two agree on the directory.
  const attachment = attachmentPath(join(home, "files"), "-100123", "photo.jpg");
  mkdirSync(attachment.dir, { recursive: true });
  writeFileSync(attachment.path, "bytes");

  mountStateHome(home);

  expect(existsSync(attachment.path)).toBe(false);
  expect(existsSync(join(home, "files"))).toBe(false); // the directory goes too — the channel recreates it per file
  expect(existsSync(turns)).toBe(true); // durable state, not scratch
});

it("creates a state home that does not exist yet, with nothing to clear", () => {
  const home = join(mkdtempSync(join(tmpdir(), "fa-state-home-")), "channels", "slack");
  expect(() => mountStateHome(home)).not.toThrow();
  expect(existsSync(home)).toBe(true);
});
