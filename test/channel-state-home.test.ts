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
import { attachmentPath, attachmentsDir } from "../src/channels/kit/attachment-path.ts";

it("clears the inbound attachments at mount and keeps the rest of the state home", () => {
  const home = join(mkdtempSync(join(tmpdir(), "fa-state-home-")), "channels", "telegram");
  mkdirSync(home, { recursive: true });
  const turns = join(home, "turns.json");
  writeFileSync(turns, "[]");
  // Placed through the SAME function the channels hand to their download paths, so the writer and the clearer
  // cannot drift apart: if `attachmentsDir` changed and `mountStateHome` did not, this file would survive.
  const attachment = attachmentPath(attachmentsDir(home), "-100123", "photo.jpg");
  mkdirSync(attachment.dir, { recursive: true });
  writeFileSync(attachment.path, "bytes");

  mountStateHome(home);

  expect(existsSync(attachment.path)).toBe(false);
  // The directory goes too — the channel recreates it per file.
  expect(existsSync(attachmentsDir(home))).toBe(false);
  expect(existsSync(turns)).toBe(true); // durable state, not scratch
});

it("nothing under src/ spells the attachments directory for itself", async () => {
  // The structural half of the same rule: `attachmentsDir` only binds the writer to the clearer while everyone goes
  // through it, and a NEW channel is exactly the caller nobody reviews for this. One assertion, naming the file.
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../src/", import.meta.url).pathname;
  const owner = "channels/kit/attachment-path.ts";
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const rel = dir === "" ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...(await walk(rel)));
      else if (rel.endsWith(".ts")) out.push(rel);
    }
    return out;
  };
  const offenders: string[] = [];
  for (const file of await walk("")) {
    if (file === owner) continue;
    if (/["']files["']/.test(await readFile(join(root, file), "utf8"))) offenders.push(file);
  }
  expect(offenders, `these spell the attachments directory themselves instead of calling attachmentsDir()`).toEqual([]);
});

it("creates a state home that does not exist yet, with nothing to clear", () => {
  const home = join(mkdtempSync(join(tmpdir(), "fa-state-home-")), "channels", "slack");
  expect(() => mountStateHome(home)).not.toThrow();
  expect(existsSync(home)).toBe(true);
});
