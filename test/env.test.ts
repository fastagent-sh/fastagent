import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvValues } from "../src/env.ts";
import { dotEnvPath, loadEnvValues } from "../src/value-file.ts";

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
});
