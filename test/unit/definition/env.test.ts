import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvValues } from "../../../packages/fastagent/src/env.ts";
import { dotEnvPath, loadEnvValues } from "../../../packages/fastagent/src/value-file.ts";

afterEach(() => vi.unstubAllEnvs());

describe("dotEnvPath", () => {
  it("is <root>/.secrets/.env", () => {
    expect(dotEnvPath("/w")).toBe(join("/w", ".secrets", ".env"));
  });
});

// The .env loader fastagent parses with itself, one dialect wherever it runs.
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
    const b = `B_${Date.now()}`;
    const c = `C_${Date.now()}`;
    const d = `D_${Date.now()}`;
    const created = [`${key}_PLAIN`, `${key}_DQ`, `${key}_SQ`, b, c, d];
    try {
      const file = await write(`# a comment\n\n${key}_PLAIN=value\n${key}_DQ="quoted spaces"\n${key}_SQ='single'\n`);
      loadEnvFile(file);
      expect(process.env[`${key}_PLAIN`]).toBe("value");
      expect(process.env[`${key}_DQ`]).toBe("quoted spaces"); // surrounding quotes stripped, inner space kept
      expect(process.env[`${key}_SQ`]).toBe("single");

      // Only the FIRST `=` splits, so a value carrying `=` or `:` survives intact.
      loadEnvFile(await write(`${b}=7676:AA=bb-cc_dd\n`));
      expect(process.env[b]).toBe("7676:AA=bb-cc_dd");

      // A real env var wins over the file…
      vi.stubEnv(c, "from_real_env");
      loadEnvFile(await write(`${c}=from_file\n`));
      expect(process.env[c]).toBe("from_real_env");

      // …and within the file, the LAST occurrence wins.
      loadEnvFile(await write(`${d}=first\n${d}=second\n`));
      expect(process.env[d]).toBe("second");
    } finally {
      for (const name of created) delete process.env[name];
    }
  });
});
