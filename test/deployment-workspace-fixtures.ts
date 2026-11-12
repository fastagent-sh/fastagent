import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DeploymentRelease } from "../src/deploy/workspace.ts";

export const dirs: string[] = [];

export const release = (id: string): DeploymentRelease => ({ version: 1, id, agent: "fastagent" });

/** The host's storage (`root`). */
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "fa-deployed-storage-"));
  dirs.push(dir);
  const root = join(dir, "data");
  await mkdir(join(root, ".deployment"), { recursive: true });
  return { dir, root };
}
