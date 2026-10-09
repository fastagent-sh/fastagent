/**
 * Release discipline of the locked auth-file write (proper-lockfile mocked): a failed unlock after
 * a successful operation must reject (a leftover auth.json.lock stalls the next writer for the
 * staleness window with zero diagnostics), while a mutation failure stays the primary error and is
 * never masked by unlock noise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { releaseMock, lockMock } = vi.hoisted(() => {
  const releaseMock = vi.fn<() => Promise<void>>();
  return { releaseMock, lockMock: vi.fn(async () => releaseMock) };
});

vi.mock("proper-lockfile", () => ({ default: { lock: lockMock } }));

import { fastagentCredentialStore } from "../src/harnesses/pi/auth.ts";

beforeEach(() => {
  releaseMock.mockReset();
  releaseMock.mockResolvedValue(undefined);
});

describe("locked auth write: release discipline (mocked proper-lockfile)", () => {
  it("a failed release after a successful write REJECTS instead of silently succeeding", async () => {
    releaseMock.mockRejectedValueOnce(new Error("EACCES: cannot remove auth.json.lock"));
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-rel-"));
    const path = join(dir, "auth.json");
    await expect(
      fastagentCredentialStore(path).modify("anthropic", async () => ({ type: "api_key", key: "sk" })),
    ).rejects.toThrow(/cannot remove auth\.json\.lock/);
    // The credential write itself landed before the cleanup failure surfaced (diagnosable state).
    expect(JSON.parse(await readFile(path, "utf8")).anthropic).toEqual({ type: "api_key", key: "sk" });
  });

  it("a mutation failure stays the primary error; unlock noise does not mask it", async () => {
    releaseMock.mockRejectedValueOnce(new Error("unlock noise"));
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-rel-"));
    const path = join(dir, "auth.json");
    await writeFile(path, "{not valid json");
    await expect(
      fastagentCredentialStore(path).modify("anthropic", async () => ({ type: "api_key", key: "sk" })),
    ).rejects.toThrow(/corrupt auth file/);
  });
});
