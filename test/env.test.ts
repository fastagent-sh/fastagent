import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dotEnvPath, loadDotEnv, loadEnvFile } from "../src/env.ts";

describe("dotEnvPath (follows the resolved secrets dir)", () => {
  it("default <root>/.secrets/.env; FASTAGENT_SECRETS_DIR moves it together with auth.json", () => {
    expect(dotEnvPath("/w", {} as NodeJS.ProcessEnv)).toBe(join("/w", ".secrets", ".env"));
    expect(dotEnvPath("/w", { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      join("/data/.secrets", ".env"),
    );
  });
});

// A portable .env loader (Node has process.loadEnvFile; Bun does not — same parse must run on both).
describe("loadEnvFile", () => {
  const write = async (content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-"));
    const file = join(dir, ".env");
    await writeFile(file, content);
    return file;
  };

  it("loads KEY=VALUE, skips comments/blank lines, strips matched quotes", async () => {
    const key = `A_${Date.now()}`;
    const file = await write(`# a comment\n\n${key}_PLAIN=value\n${key}_DQ="quoted spaces"\n${key}_SQ='single'\n`);
    loadEnvFile(file);
    expect(process.env[`${key}_PLAIN`]).toBe("value");
    expect(process.env[`${key}_DQ`]).toBe("quoted spaces"); // surrounding quotes stripped, inner space kept
    expect(process.env[`${key}_SQ`]).toBe("single");
  });

  it("keeps a value with '=' and ':' intact (only splits on the first =)", async () => {
    const key = `B_${Date.now()}`;
    const file = await write(`${key}=7676:AA=bb-cc_dd\n`);
    loadEnvFile(file);
    expect(process.env[key]).toBe("7676:AA=bb-cc_dd");
  });

  it("does NOT override an already-set var — a real env var wins", async () => {
    const key = `C_${Date.now()}`;
    process.env[key] = "from_real_env";
    const file = await write(`${key}=from_file\n`);
    loadEnvFile(file);
    expect(process.env[key]).toBe("from_real_env");
  });

  it("in-file duplicate key takes the LAST occurrence", async () => {
    const key = `D_${Date.now()}`;
    const file = await write(`${key}=first\n${key}=second\n`);
    loadEnvFile(file);
    expect(process.env[key]).toBe("second");
  });

  // The whole Bun fix rests on loadEnvFile being equivalent to Node's process.loadEnvFile. Prove it
  // DIFFERENTIALLY: feed the SAME file to both and assert process.env agrees. Node-only (Bun, the very
  // runtime we're porting to, has no process.loadEnvFile) — skipped there.
  it.skipIf(typeof process.versions.bun === "string")(
    "matches Node's process.loadEnvFile on the same file (env-wins + in-file last-wins)",
    async () => {
      const p = `E_${Date.now()}`; // fresh keys so neither loader collides with real env
      const preset = `${p}_PRESET`;
      const keys = [`${p}_PLAIN`, `${p}_DUP`, `${p}_QUOTED`, preset];
      const content = `${p}_PLAIN=one\n# comment\n${p}_DUP=a\n${p}_DUP=b\n${p}_QUOTED="q v"\n${preset}=from_file\n`;
      const file = await write(content);

      const run = (load: (f: string) => void): Record<string, string | undefined> => {
        for (const k of keys) delete process.env[k];
        process.env[preset] = "real"; // a real env var both loaders must NOT clobber
        load(file);
        return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
      };

      expect(run(loadEnvFile)).toEqual(run(process.loadEnvFile.bind(process)));
      for (const k of keys) delete process.env[k];
    },
  );

  it("propagates ENOENT for a missing file (the caller decides it's normal)", async () => {
    expect(() => loadEnvFile(join(tmpdir(), `no-such-${Date.now()}`, ".env"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

describe("loadDotEnv (workspace <root>/.secrets/.env, missing is normal)", () => {
  it("a dir with no .env is a no-op, not a throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-dotenv-"));
    expect(() => loadDotEnv(dir)).not.toThrow(); // ENOENT swallowed
  });

  it("a NON-ENOENT read error propagates (a corrupt/unreadable .env fails visibly, never silently)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-dotenv-bad-"));
    // A directory AT the .env path makes readFileSync throw EISDIR — a non-ENOENT error that must surface.
    await mkdir(join(dir, ".secrets", ".env"), { recursive: true });
    expect(() => loadDotEnv(dir)).toThrow(expect.objectContaining({ code: "EISDIR" }));
  });
});
