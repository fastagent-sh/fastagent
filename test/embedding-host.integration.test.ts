import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readContentSource } from "../src/index.ts";

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("an agent's own content, from the package entry", () => {
  const folders = async () => {
    const base = await tmp("fa-host-content-");
    const made = ["notes", "app", "handbook"].map((name) => join(base, name));
    for (const dir of made) await mkdir(dir);
    return { base, notes: made[0] as string, app: made[1] as string, handbook: made[2] as string };
  };

  it("reads a folder as the CLI does: named for it, used as it is", async () => {
    const { notes } = await folders();
    const { addition } = readContentSource(notes, process.cwd(), { description: "My notes." });
    expect(addition).toEqual({ name: "notes", entry: { path: notes, description: "My notes." } });
  });
});
