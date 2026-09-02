/**
 * What AWS actually answers, checked against the assumptions the AgentCore driver makes about it.
 * `deploy-agentcore-run.test.ts` drives the whole deploy against a fake `CliRunner`; that covers the
 * orchestration and cannot cover the belief.
 *
 * READ-ONLY, and unlike the fly/railway pair this one carries real weight on its own: the CloudFormation
 * template is YAML this repo emits line by line, and `validate-template` is CloudFormation's own parser
 * saying whether it would accept it — for free, in a second, without creating anything. The deploy probe
 * next door proves the stack CONVERGES; this proves the template is well-formed even when nobody wants
 * to wait eight minutes.
 *
 * Needs `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` and the `aws` CLI. Nothing here
 * creates a resource: STS identity, a template validation, and two describes against names that do
 * not exist.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TEMPLATE_FILE, agentcoreName, stateBucketName } from "../../src/deploy/agentcore/plan.ts";
import { CLI, aws, run, requireEnv } from "./env.ts";

requireEnv("AWS_ACCESS_KEY_ID", "an AWS key for an account that can reach Bedrock AgentCore");
requireEnv("AWS_SECRET_ACCESS_KEY", "the secret for AWS_ACCESS_KEY_ID");
requireEnv("AWS_REGION", "a region where Bedrock AgentCore is available, e.g. us-east-1");

/** Generated artifact dirs, removed however the run ends: this probe writes a template per run and
 *  creates nothing in AWS, so the only thing it can leak is disk. */
const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("aws CLI output still matches what the AgentCore driver reads", () => {
  it("`sts get-caller-identity --output json` carries the Account the driver reads", async () => {
    const { code, stdout } = await aws(["sts", "get-caller-identity", "--output", "json"]);
    expect(code, `sts get-caller-identity failed: ${stdout}`).toBe(0);

    // run.ts parses this inline (`JSON.parse(identity.stdout).Account`) and gates on a non-string.
    // The account id is not cosmetic — it suffixes the state bucket, whose name is global.
    const account = (JSON.parse(stdout) as { Account?: unknown }).Account;
    expect(typeof account, "get-caller-identity no longer returns a string Account").toBe("string");
    expect(stateBucketName(agentcoreName("fastagent-live-probe"), account as string)).toMatch(/^fa-[a-z0-9-]+-\d+$/);
  });

  it("CloudFormation accepts the template this repo generates", async () => {
    // The generated template is emitted line by line in plan.ts. Offline tests assert what it
    // CONTAINS; only CloudFormation can say whether it parses — and a template that does not is a
    // deploy that fails after the image is already built and pushed.
    // `live-probe-` and NOT `fastagent-`: the driver prefixes the directory name for every resource
    // it creates (stack `fastagent-<name>`, repo `fastagent/<name>`, lambda
    // `fastagent-<name>-forwarder`), so a directory already called `fastagent-...` yields
    // `fastagent-fastagent-...` and escapes the IAM policy that scopes this credential.
    const dir = await mkdtemp(join(tmpdir(), "live-probe-"));
    dirs.push(dir);
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    // selfSchedule AND a schedule file, so the branch that carries the YAML most likely to be wrong is
    // the one CloudFormation reads: a bare agent emits ~100 lines and NONE of the forwarder Lambda, its
    // Function URL, the two Lambda permissions, the wake/scheduler IAM roles or an
    // `AWS::Scheduler::Schedule`. This fixture emits all of them and still creates nothing.
    await writeFile(
      join(dir, "fastagent.config.mjs"),
      `export default { model: "openai-codex/gpt-5.5", selfSchedule: true };\n`,
    );
    // A plain default export, not `defineSchedule(...)`: loadSchedules validates the SHAPE, and this
    // fixture has no node_modules to import the package's helper from.
    await mkdir(join(dir, "schedules"), { recursive: true });
    await writeFile(join(dir, "schedules", "nightly.mjs"), `export default { cron: "0 3 * * *", prompt: "probe" };\n`);
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "p", private: true }, null, 2)}\n`);
    // Generation only: `deploy agentcore` without --run writes artifacts and touches no AWS API.
    const generated = await run(process.execPath, [CLI, "deploy", "agentcore"], dir);
    expect(generated.stderr, "generation did not write a template").toContain(TEMPLATE_FILE);

    const validated = await aws([
      "cloudformation",
      "validate-template",
      "--template-body",
      `file://${join(dir, TEMPLATE_FILE)}`,
    ]);
    expect(validated.code, `CloudFormation rejected the generated template:\n${validated.stderr}`).toBe(0);
  });

  it("a stack and a repository that do not exist answer 'not found', not 'denied'", async () => {
    // The driver's check-then-act reads these two failures as "absent, go create". If the credential
    // ever loses the permission instead, the same non-zero exit would send it into create — so what
    // the failure SAYS is what separates a first deploy from a broken key.
    const stack = await aws(["cloudformation", "describe-stacks", "--stack-name", "fastagent-live-probe-absent"]);
    expect(stack.code).not.toBe(0);
    expect(stack.stderr, `describe-stacks on a missing stack now says: ${stack.stderr}`).toMatch(
      /does not exist|ValidationError/i,
    );

    const repo = await aws(["ecr", "describe-repositories", "--repository-names", "fastagent/live-probe-absent"]);
    expect(repo.code).not.toBe(0);
    expect(repo.stderr, `describe-repositories on a missing repo now says: ${repo.stderr}`).toMatch(
      /RepositoryNotFound/i,
    );
  });
});
