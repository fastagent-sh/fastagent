import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deploymentName } from "../src/deploy/deployment-name.ts";

async function agent(directory: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-name-")), directory);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  return dir;
}

describe("the name of a deployment", () => {
  it("is the configuration's name, else the program's as one segment: package.json's, else the directory's", async () => {
    const named = await agent("acme-reviewer", { "package.json": '{ "name": "@acme/reviewer" }' });
    expect(await deploymentName(named)).toBe("acme-reviewer");
    expect(await deploymentName(await agent("my.agent"))).toBe("my-agent");
    const config = join(await mkdtemp(join(tmpdir(), "fa-name-config-")), "acme.json");
    await writeFile(config, '{ "name": "acme" }');
    expect(await deploymentName(named, config)).toBe("acme");
    await writeFile(config, "{}");
    expect(await deploymentName(named, config)).toBe("acme-reviewer");
  });

  it("refuses a name that is not one segment, and a configuration it cannot read, naming the file", async () => {
    const dir = await agent("a");
    const config = join(await mkdtemp(join(tmpdir(), "fa-name-bad-")), "bad.json");
    await writeFile(config, '{ "name": "a/b" }');
    await expect(deploymentName(dir, config)).rejects.toThrow('the instance name "a/b" must be one path segment');
    await writeFile(config, '{ "name": 7 }');
    await expect(deploymentName(dir, config)).rejects.toThrow(`${config}: "name" must be a string`);
    await expect(deploymentName(dir, join(dir, "absent.json"))).rejects.toThrow(
      "cannot read the instance configuration",
    );
  });
});
