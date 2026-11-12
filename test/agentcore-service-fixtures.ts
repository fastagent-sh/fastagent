import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildable } from "./cli-run.ts";
import { CODEX_MODEL } from "./codex-model.ts";

export async function agentDir(
  files: Record<string, string> = {},
  config = `{ defaults: { model: "${CODEX_MODEL}" } }`,
) {
  const dir = await mkdtemp(join(tmpdir(), "fa-agentcore-"));
  await writeFile(join(dir, "fastagent.config.ts"), `export default ${config};\n`);
  await writeFile(join(dir, "SYSTEM.md"), "You are a test agent.\n");
  await buildable(dir);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), body);
  }
  return dir;
}
