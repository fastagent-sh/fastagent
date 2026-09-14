/**
 * One property, and the only way to reach it: `claimSlot` creates the claim before it stamps it, so a failing stamp
 * must take the claim back down. Injecting that failure needs `node:fs` itself mocked, which is why this property
 * lives in its own file rather than in `scheduler.test.ts`.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let failStamp = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (failStamp) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      return actual.writeFileSync(...args);
    },
  };
});

const { claimSlot } = await import("../src/schedule/state.ts");

const dirs: string[] = [];
afterEach(() => {
  failStamp = false;
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
  // Left behind, an unstamped claim would read as `duplicate` forever: the slot taken, never run, never audited.
  const root = fresh();
  const slot = new Date("2026-07-07T10:00:00Z");
  failStamp = true;
  expect(() => claimSlot(root, "job", slot, slot)).toThrow(/ENOSPC/);
  expect(claims(root)).toEqual([]);

  failStamp = false;
  expect(claimSlot(root, "job", slot, slot)).toEqual({ taken: true }); // the same slot still fires
  expect(claims(root)).toEqual(["2026-07-07T10-00-00-000Z"]);
});
