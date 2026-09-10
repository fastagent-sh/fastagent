import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvValues, dotEnvPath, loadDotEnv, loadEnvValues } from "../src/env.ts";

describe("dotEnvPath (follows the resolved secrets dir)", () => {
  it("default <root>/.secrets/.env; FASTAGENT_SECRETS_DIR moves it together with auth.json", () => {
    expect(dotEnvPath("/w", {} as NodeJS.ProcessEnv)).toBe(join("/w", ".secrets", ".env"));
    expect(dotEnvPath("/w", { FASTAGENT_SECRETS_DIR: "/data/.secrets" } as NodeJS.ProcessEnv)).toBe(
      join("/data/.secrets", ".env"),
    );
  });
});

// A portable .env loader (Node has process.loadEnvFile; Bun does not — same parse must run on both).
describe("loadEnvValues + applyEnvValues", () => {
  const write = async (content: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-"));
    const file = join(dir, ".env");
    await writeFile(file, content);
    return file;
  };
  const loadEnvFile = (file: string): void => applyEnvValues(loadEnvValues(file));

  it("parses KEY=VALUE: comments/blanks skipped, quotes stripped, first-= split, env-wins, last-wins", async () => {
    const key = `A_${Date.now()}`;
    const file = await write(`# a comment\n\n${key}_PLAIN=value\n${key}_DQ="quoted spaces"\n${key}_SQ='single'\n`);
    loadEnvFile(file);
    expect(process.env[`${key}_PLAIN`]).toBe("value");
    expect(process.env[`${key}_DQ`]).toBe("quoted spaces"); // surrounding quotes stripped, inner space kept
    expect(process.env[`${key}_SQ`]).toBe("single");

    // Only the FIRST `=` splits, so a value carrying `=` or `:` survives intact.
    const b = `B_${Date.now()}`;
    loadEnvFile(await write(`${b}=7676:AA=bb-cc_dd\n`));
    expect(process.env[b]).toBe("7676:AA=bb-cc_dd");

    // A real env var wins over the file…
    const c = `C_${Date.now()}`;
    process.env[c] = "from_real_env";
    loadEnvFile(await write(`${c}=from_file\n`));
    expect(process.env[c]).toBe("from_real_env");

    // …and within the file, the LAST occurrence wins.
    const d = `D_${Date.now()}`;
    loadEnvFile(await write(`${d}=first\n${d}=second\n`));
    expect(process.env[d]).toBe("second");
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

  it("a missing file is no values; an unreadable one still throws", async () => {
    expect(loadEnvValues(join(tmpdir(), `no-such-${Date.now()}`, ".env")).size).toBe(0);
    const dir = await mkdtemp(join(tmpdir(), "fa-env-bad-"));
    await mkdir(join(dir, ".env")); // a directory at the path → EISDIR, which must surface
    expect(() => loadEnvValues(join(dir, ".env"))).toThrow(expect.objectContaining({ code: "EISDIR" }));
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

describe("env: a stray .env at the agent root is announced, not silently ignored", () => {
  it("warns only about keys fastagent itself reads — an application's .env is not ours to lecture about", async () => {
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir, homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadDotEnv } = await import("../src/env.ts");
    const { log } = await import("../src/log.ts");

    const agent = join(await mkdtemp(join(tmpdir(), "fa-stray-")), "fastagent");
    await mkdir(agent);
    await writeFile(join(agent, "fastagent.config.mjs"), "export default {};\n"); // THE marker
    await writeFile(join(agent, ".env"), "FASTAGENT_MODEL=prov/m\n"); // NOT the file fastagent reads
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      loadDotEnv(agent);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/is NOT read — it sets FASTAGENT_MODEL/);
      expect(process.env.FASTAGENT_MODEL).toBeUndefined(); // announced, never loaded behind the user's back

      // An agent directory can be the author's repository too (`--agent-dir .` exists for that shape),
      // where a root `.env` is their APPLICATION's and "move the values there" would break it. Nothing
      // here can tell those apart, so the warning is scoped to keys fastagent itself reads — and stays
      // silent about everything else, however long the agent runs without a `.secrets/.env`.
      await writeFile(join(agent, ".env"), "DATABASE_URL=postgres://real\n");
      warn.mockClear();
      loadDotEnv(agent);
      expect(warn).not.toHaveBeenCalled();

      // …and the agent's own env still loads from the right place, warning or not.
      await mkdir(join(agent, ".secrets"), { recursive: true });
      await writeFile(join(agent, ".secrets", ".env"), "REAL=1\n");
      loadDotEnv(agent);
      expect(process.env.REAL).toBe("1");

      // Nothing to warn about where fastagent's own machinery home lives (no root `.env` there).
      warn.mockClear();
      loadDotEnv(homedir());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
