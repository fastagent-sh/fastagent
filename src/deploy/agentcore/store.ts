/**
 * AgentCore's values as a deployment's store: one Secrets Manager secret per deployment, a JSON object of NAME → value
 * that the container reads on its first invocation (runtime-secrets.ts). It lives outside the stack, as the ECR
 * repository and the artifact bucket do: its values must exist before the first deploy, and a stack update must not be
 * what rewrites them.
 *
 * Reading goes around `awsCli().read`, whose unreadable answer quotes stdout: here stdout is every value.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_FILE_MODE } from "../../paths.ts";
import type { CliRunner } from "../runner.ts";
import type { SecretStore } from "../secret-store.ts";
import { awsCli, awsJson } from "./aws-cli.ts";

export interface AgentcoreSecretStore extends SecretStore {
  /** The secret's ARN, which the stack takes as its `SecretArn` parameter. */
  arn(): Promise<string>;
}

const describe = (secretName: string, ...query: string[]) => [
  "secretsmanager",
  "describe-secret",
  "--secret-id",
  secretName,
  ...query,
];

/** The values the secret holds now. A secret that is not a JSON object of strings is refused, naming nothing in it. */
function parseValues(secretString: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error("its value is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("its value is not a JSON object of NAME → value");
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`its value for ${name} is not a string`);
  }
  return parsed as Record<string, string>;
}

export function agentcoreSecretStore(
  aws: CliRunner,
  secretName: string,
  log: (message: string) => void,
): AgentcoreSecretStore {
  const cli = awsCli(aws);

  const current = async (): Promise<Record<string, string>> => {
    const { code, stdout, stderr } = await aws(
      ["secretsmanager", "get-secret-value", "--secret-id", secretName, "--query", "SecretString", "--output", "text"],
      { capture: true, captureStderr: true },
    );
    if (code !== 0) {
      throw new Error(`\`aws secretsmanager get-secret-value\` failed: ${(stderr ?? "").trim().slice(0, 300)}`);
    }
    try {
      return parseValues(stdout.trim());
    } catch (error) {
      throw new Error(`the secret ${secretName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const store: AgentcoreSecretStore = {
    async exists() {
      const read = await cli.read(
        describe(secretName, "--output", "json"),
        awsJson((parsed) => parsed ?? undefined),
      );
      if ("unreadable" in read) throw new Error(`could not read secret ${secretName}: ${read.unreadable}`);
      if ("absent" in read) return false;
      if ((read.ok as { DeletedDate?: unknown }).DeletedDate !== undefined) {
        throw new Error(
          `secret ${secretName} is scheduled for deletion: \`aws secretsmanager restore-secret --secret-id ${secretName}\` ` +
            `brings it back, or wait for the deletion and re-run`,
        );
      }
      return true;
    },
    async ensure() {
      if (await store.exists()) return;
      log(`creating secret ${secretName}…`);
      const created = await cli.write([
        "secretsmanager",
        "create-secret",
        "--name",
        secretName,
        "--description",
        "FastAgent deployment values",
        "--secret-string",
        "{}",
      ]);
      if (!("done" in created)) {
        throw new Error(`\`aws secretsmanager create-secret\` failed: ${"refused" in created ? created.refused : ""}`);
      }
    },
    async names() {
      return new Set(Object.keys(await current()));
    },
    async write(values) {
      const names = Object.keys(values);
      log(`setting ${names.length} value(s) in ${secretName}: ${names.join(", ")}`);
      // Read, merge, write: one operator at a time, as every host's store assumes.
      const merged = { ...(await current()), ...values };
      // Over a file only this process can read, never argv.
      const dir = await mkdtemp(join(tmpdir(), "fastagent-secret-"));
      try {
        const file = join(dir, "secret.json");
        await writeFile(file, JSON.stringify(merged), { mode: SECRET_FILE_MODE });
        const { code, stderr } = await aws(
          ["secretsmanager", "put-secret-value", "--secret-id", secretName, "--secret-string", `file://${file}`],
          { capture: true, captureStderr: true },
        );
        if (code !== 0) {
          throw new Error(`\`aws secretsmanager put-secret-value\` failed: ${(stderr ?? "").trim().slice(0, 300)}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async arn() {
      const read = await cli.read(
        describe(secretName, "--query", "ARN", "--output", "text"),
        (stdout) => stdout.trim() || undefined,
      );
      if (!("ok" in read)) {
        throw new Error(
          `could not read the ARN of secret ${secretName}: ${"unreadable" in read ? read.unreadable : "absent"}`,
        );
      }
      return read.ok;
    },
  };
  return store;
}
