/**
 * The AgentCore project `fastagent deploy init agentcore` writes into the agent directory, for the AgentCore CLI to deploy:
 * `agentcore/agentcore.json` with one runtime built from the agent directory's Dockerfile, and the CDK app that
 * `agentcore deploy` synthesizes, its stack adding {@link FastAgentResources}. The CDK app is the AgentCore CLI's own, as
 * `agentcore create` writes it in {@link AGENTCORE_CLI}, so the CLI of that version deploys it.
 *
 * Once written, the project is the author's: a target, a runtime setting or a resource of their own is theirs to add,
 * and `init` never writes over it.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The AgentCore CLI that deploys the project, pinned: the CDK app is the one this version writes. */
export const AGENTCORE_CLI = "@aws/agentcore@1.0.3";

/** The project's files, agent-directory-relative, from `templates/` (a dotfile there is stored without its dot). */
const FILES: [template: string, path: string][] = [
  ["agentcore.json", "agentcore/agentcore.json"],
  ["aws-targets.json", "agentcore/aws-targets.json"],
  ["gitignore", "agentcore/.gitignore"],
  ["cdk/bin/cdk.ts", "agentcore/cdk/bin/cdk.ts"],
  ["cdk/lib/cdk-stack.ts", "agentcore/cdk/lib/cdk-stack.ts"],
  ["cdk/cdk.json", "agentcore/cdk/cdk.json"],
  ["cdk/package.json", "agentcore/cdk/package.json"],
  ["cdk/tsconfig.json", "agentcore/cdk/tsconfig.json"],
  ["cdk/gitignore", "agentcore/cdk/.gitignore"],
];

const template = (name: string): string =>
  readFileSync(new URL(`../templates/agentcore/${name}`, import.meta.url), "utf8");

/** AgentCore's rule for a project name: a letter, then letters and digits, 23 at most. */
export function projectName(agentName: string): string {
  const name = agentName.replace(/[^A-Za-z0-9]/g, "").replace(/^[0-9]+/, "");
  return (name || "agent").slice(0, 23);
}

export interface ProjectInput {
  /** The AgentCore project's name. */
  project: string;
  /** The Secrets Manager secret the agent's values are in. */
  secret: string;
  /** This package's version, which the CDK app depends on. */
  version: string;
}

/** Write the project under `agentDir`, unless it has one: answers whether it wrote it. */
export async function writeProject(agentDir: string, input: ProjectInput): Promise<boolean> {
  if (existsSync(join(agentDir, "agentcore"))) return false;
  const values: Record<string, string> = { ...input };
  for (const [name, path] of FILES) {
    const content = template(name).replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const value = values[key];
      if (value === undefined)
        throw new Error(`templates/agentcore/${name} names {{${key}}}, which init has no value for`);
      return value;
    });
    await mkdir(dirname(join(agentDir, path)), { recursive: true });
    await writeFile(join(agentDir, path), content);
  }
  return true;
}
