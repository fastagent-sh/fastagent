import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { flyTomlFile } from "../src/deploy/fly/plan.ts";
import { hostCli } from "./host-cli-double.ts";

/** Whether `pid` runs: signal 0 only asks. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The variables a generated `fly.<name>.toml` sets on the box, as the box reads them. */
export async function flyVariables(dir: string, name: string): Promise<Record<string, string>> {
  const toml = await readFile(join(dir, flyTomlFile(name)), "utf8");
  const found = [...toml.matchAll(/^ {2}(FASTAGENT_(?:NAME|RELEASE_ID|CONFIG_JSON)) = (".*")$/gm)];
  return Object.fromEntries(found.map((m) => [m[1] as string, JSON.parse(m[2] as string) as string]));
}

/** The configuration a deploy of `dir` to Fly delivers, parsed. */
export async function flyConfig(dir: string, name: string): Promise<unknown> {
  return JSON.parse((await flyVariables(dir, name)).FASTAGENT_CONFIG_JSON as string);
}

/** An `aws` and a `docker` that answer the reads before the build; `held` is what the secret holds. */
export function fakeAwsAndDocker(held: string) {
  const calls: string[] = [];
  hostCli("aws", ({ args }) => {
    calls.push(args.join(" "));
    switch (`${args[0]} ${args[1]}`) {
      case "sts get-caller-identity":
        return { stdout: '{"Account":"123456789012"}\n' };
      case "configure get":
        return { stdout: "us-west-2\n" };
      case "cloudformation describe-stacks":
        return { code: 254, stderr: "Stack with id x does not exist\n" };
      case "secretsmanager describe-secret":
        return { stdout: '{"Name":"x"}\n' };
      case "secretsmanager get-secret-value":
        return { stdout: `${held}\n` };
      case "bedrock-agentcore-control list-agent-runtimes":
        return { stdout: "{}\n" };
      default:
        return { code: 1 };
    }
  });
  hostCli("docker", ({ args }) => {
    calls.push(`docker ${args.join(" ")}`);
    return { code: args[0] === "version" || args[0] === "buildx" ? 0 : 1 };
  });
  return { calls: () => calls.join("\n") };
}
