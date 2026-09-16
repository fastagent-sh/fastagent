/**
 * The two claim properties whose failure can only be injected by mocking `node:fs`, which is why they live in their
 * own file rather than in `scheduler.test.ts`: a stamp write that fails must take the claim back down, and a claim
 * that disappears between the listing and the read must degrade rather than fail the boot.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let failStamp = false;
let vanishOnRead = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failStamp) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return actual.writeFileSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (vanishOnRead) throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return actual.readFileSync(...args);
    },
  };
});

const { claimSlot, readFires } = await import("../src/schedule/state.ts");

const dirs: string[] = [];
afterEach(() => {
  failStamp = false;
  vanishOnRead = false;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "fa-claim-"));
  dirs.push(dir);
  return dir;
};
const claims = (root: string): string[] => {
  try {
    return readdirSync(join(root, "schedule", "claims", "job"));
  } catch {
    return [];
  }
};

it("a failed stamp takes the claim back down, so the slot is not eaten by a full disk", () => {
  // Left behind, an unstamped claim would read as `duplicate` forever: the slot taken, never run, never reported.
  const root = fresh();
  const slot = new Date("2026-07-07T10:00:00Z");
  failStamp = true;
  expect(() => claimSlot(root, "job", slot, slot)).toThrow(/ENOSPC/);
  expect(claims(root)).toEqual([]);

  failStamp = false;
  expect(claimSlot(root, "job", slot, slot)).toEqual({ taken: true }); // the same slot still fires
  expect(claims(root)).toEqual(["2026-07-07T10-00-00-000Z"]);
});

it("a claim pruned between the listing and the read is DROPPED, not read as an unsettled fire", () => {
  // A concurrent claim prunes while this one is reading. Two things must hold: `readFires` must not throw (the
  // history is read by a CLI command that should refuse in one line, not crash), and the vanished claim must not
  // come back as an `outcome`-less fire — `unreported` is a claim about a run, and this one no longer exists.
  const root = fresh();
  const slot = new Date("2026-07-07T10:00:00Z");
  expect(claimSlot(root, "job", slot, new Date("2026-07-07T10:00:03Z"))).toEqual({ taken: true });
  vanishOnRead = true;
  expect(readFires(root, "job")).toEqual([]);
});
