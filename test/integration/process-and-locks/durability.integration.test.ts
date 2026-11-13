import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../../src/atomic-write.ts";
import { openLockedStorage } from "../../../src/harnesses/pi-durable/storage.ts";
import { withLockedFile } from "../../../src/locked-file.ts";

const roots: string[] = [];
const freshDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runNode(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("withLockedFile and writeFileAtomic: cross-process serialization and file safety", () => {
  it("serializes concurrent read-modify-write updates across processes without losing any increment", async () => {
    const dir = freshDir("fa-lock-");
    const target = join(dir, "count.json");
    writeFileSync(target, JSON.stringify({ count: 0 }));

    const moduleUrl = pathToFileURL(new URL("../../../src/locked-file.ts", import.meta.url).pathname).href;
    const worker = `
      import { withLockedFile } from ${JSON.stringify(moduleUrl)};
      const file = process.argv[1];
      for (let i = 0; i < 5; i++) {
        await withLockedFile(file, async (raw) => {
          const data = JSON.parse(raw ?? '{"count":0}');
          return { result: undefined, next: JSON.stringify({ count: data.count + 1 }) };
        });
      }
    `;
    const results = await Promise.all([
      runNode(worker, [target]),
      runNode(worker, [target]),
      runNode(worker, [target]),
    ]);
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ count: 15 });
  });

  it("writes through a symlink to its target without replacing the link, and keeps 0600 over a stale temp", async () => {
    const dir = freshDir("fa-atomic-");
    const real = join(dir, "real-auth.json");
    const link = join(dir, "auth.json");
    writeFileSync(real, "{}");
    symlinkSync(real, link);

    // Pre-existing stale temp with loose permissions must still end up 0600 on the target.
    writeFileSync(`${real}.tmp`, "stale", { mode: 0o644 });
    chmodSync(`${real}.tmp`, 0o644);
    await withLockedFile(link, async () => ({ result: undefined, next: '{"ok":true}' }));

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe('{"ok":true}');
    expect(lstatSync(real).mode & 0o777).toBe(0o600);

    // A write failure leaves the existing file untouched.
    mkdirSync(`${real}.tmp`, { recursive: true });
    expect(() => writeFileAtomic(real, '{"corrupt":true}', 0o600)).toThrow(/EISDIR|illegal operation on a directory/);
    expect(readFileSync(real, "utf8")).toBe('{"ok":true}');
  });

  it("refuses to write if the caller's AbortSignal fires before commit", async () => {
    const dir = freshDir("fa-abort-");
    const target = join(dir, "state.json");
    writeFileSync(target, '{"v":1}');
    const controller = new AbortController();

    await expect(
      withLockedFile(
        target,
        async () => {
          controller.abort(new Error("caller timed out"));
          return { result: undefined, next: '{"v":2}' };
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("caller timed out");
    expect(readFileSync(target, "utf8")).toBe('{"v":1}');
  });
});

describe("openLockedStorage: exclusive SQLite locking across processes", () => {
  it("refuses a second process while held, then opens once released", async () => {
    const dir = freshDir("fa-sqlite-lock-");
    const db = join(dir, "agent.sqlite");
    const storageUrl = pathToFileURL(
      new URL("../../../src/harnesses/pi-durable/storage.ts", import.meta.url).pathname,
    ).href;

    const holder = await openLockedStorage(db, "posix", "dev", 0);
    const contender = await runNode(
      `
        import { openLockedStorage } from ${JSON.stringify(storageUrl)};
        try {
          await openLockedStorage(process.argv[1], "posix", "dev", 0);
          process.exit(0);
        } catch (error) {
          console.error(error.message);
          process.exit(2);
        }
      `,
      [db],
    );
    expect(contender.code).toBe(2);
    expect(contender.stderr).toContain("is held by another process: dev is running");

    await holder.close({} as never);
    const afterRelease = await openLockedStorage(db, "posix", "dev", 0);
    await afterRelease.close({} as never);
  });

  it("clears a stale <db>.lock directory in leased-dotfile mode", async () => {
    const dir = freshDir("fa-dotfile-lock-");
    const db = join(dir, "agent.sqlite");
    mkdirSync(`${db}.lock`);
    const storage = await openLockedStorage(db, "leased-dotfile", "serve", 0);
    await storage.close({} as never);
  });
});
