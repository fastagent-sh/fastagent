/**
 * The model catalog file a refresh writes and every runtime reads without a lock: a read sees the old catalog or the
 * new one, never one cut short, and a file that is really corrupt still says so.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { catalogFileStore, globalCatalogPath, inGlobalCatalog } from "../src/engines/pi/models.ts";

const MODELS_MODULE = pathToFileURL(join(import.meta.dirname, "../src/engines/pi/models.ts")).href;

afterEach(async () => {
  await rm(globalCatalogPath(), { force: true });
});

/** Two catalogs of different sizes (about 30 KB and half that), each marked, newer than pi's bundled catalog. */
const WRITER = `
const { catalogFileStore } = await import(process.env.MODELS_MODULE);
const store = catalogFileStore(process.env.CATALOG);
const entry = (tag, count) => ({
  models: [{ id: "marker-" + tag }, ...Array.from({ length: count }, (_, i) => ({ id: tag + "-" + i, name: "x".repeat(60) }))],
  lastModified: Date.now() + 86_400_000,
});
const versions = [entry("a", 300), entry("b", 150)];
for (let n = 0; ; n++) {
  await store.write("anthropic", versions[n % 2]);
  if (n === 0) process.stdout.write("ready\\n");
}
`;

describe("the model catalog file", () => {
  it("a read racing a refresh's writes in another process sees a whole catalog every time", async () => {
    // A file of its own: the writer is killed mid-loop, possibly holding the lock, and a lock left behind stalls the
    // next writer of that file until it goes stale (30 s).
    const dir = await mkdtemp(join(tmpdir(), "fa-catalog-race-"));
    const path = join(dir, "models-store.json");
    const writer = spawn(process.execPath, ["--input-type=module", "-e", WRITER], {
      env: { ...process.env, MODELS_MODULE, CATALOG: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    writer.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        writer.stdout.on("data", (chunk) => String(chunk).includes("ready") && resolve());
        writer.on("exit", (code) => reject(new Error(`the writer exited (${code}) before writing: ${stderr}`)));
      });
      // ONE read each, classified: a whole version, or anything else. A file cut short by an in-place rewrite reads
      // mostly as EMPTY (truncated, not yet written), which parses as an empty catalog, so "not version a" must not
      // count as version b.
      const store = catalogFileStore(path);
      const failures: string[] = [];
      const seen = { a: 0, b: 0 };
      for (const until = Date.now() + 1_500; Date.now() < until; ) {
        try {
          const marker = (await store.read("anthropic"))?.models[0]?.id;
          if (marker === "marker-a") seen.a++;
          else if (marker === "marker-b") seen.b++;
          else failures.push(`read neither version: ${marker ?? "no entry"}`);
        } catch (error) {
          failures.push(String(error));
        }
      }
      expect(writer.exitCode, stderr).toBeNull(); // still writing: every read above raced a write
      expect(failures.slice(0, 3), `${failures.length} torn reads of ${failures.length + seen.a + seen.b}`).toEqual([]);
      // Both versions were read, so the reads really did interleave with the writes.
      expect(seen.a).toBeGreaterThan(0);
      expect(seen.b).toBeGreaterThan(0);
    } finally {
      const exited = once(writer, "exit");
      writer.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a write cancelled while it waits for the lock leaves the file as it was", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-catalog-cancel-"));
    const path = join(dir, "models-store.json");
    const store = catalogFileStore(path);
    // The store keeps entries as given; a model's other fields are pi's business.
    const entry = (id: string) => ({ models: [{ id }] }) as unknown as ModelsStoreEntry;
    const before = entry("kept");
    await store.write("anthropic", before);
    // Another refresh holds the lock (pi's settings), past this one's timeout or cancel.
    const release = await lockfile.lock(path, { realpath: false });
    try {
      const controller = new AbortController();
      const writing = store.write("anthropic", entry("late"), { signal: controller.signal });
      controller.abort();
      await release();
      await expect(writing).rejects.toThrow(/abort/i);
      expect(await store.read("anthropic")).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a corrupt file is still reported as one, and a write refuses to replace it", async () => {
    const path = globalCatalogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ "anthropic": { "models": [');
    const corrupt = new RegExp(`model catalog ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not valid JSON \\(`);
    await expect(inGlobalCatalog("anthropic", "x")).rejects.toThrow(corrupt);
    // Serializing over it would drop every other provider's entries.
    await expect(catalogFileStore(path).write("openai", { models: [] })).rejects.toThrow(corrupt);
    expect(await readFile(path, "utf8")).toBe('{ "anthropic": { "models": [');
  });

  it("an empty file is an empty catalog: the writer creates the file an instant before its first content", async () => {
    const path = globalCatalogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    expect(await inGlobalCatalog("anthropic", "x")).toBe(false);
    expect(await catalogFileStore(path).read("anthropic")).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});
