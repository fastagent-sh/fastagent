import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An agent directory, as `init` produces one, with real credential files; `files` land in it. */
export async function agent(files: Record<string, string> = {}): Promise<string> {
  const host = await mkdtemp(join(tmpdir(), "fa-preflight-"));
  const dir = join(host, "agent");
  await mkdir(join(dir, ".secrets"), { recursive: true });
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n"); // THE marker
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ type: "module", name: "agent", dependencies: { "@fastagent-sh/fastagent": "*" } }),
  );
  // Real credential files: the leak check only fires on paths that EXIST (nothing else can be baked).
  await writeFile(join(dir, ".secrets", "auth.json"), "{}\n");
  await writeFile(join(dir, ".secrets", ".env"), "K=v\n");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true }); // a fixture may name a nested file (src/tools/…)
    await writeFile(join(dir, name), content);
  }
  return dir;
}
