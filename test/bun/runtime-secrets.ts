/**
 * The AgentCore container's read of its secret on Bun, where vitest does not run: CI's Bun job runs this file
 * (`bun test/bun/runtime-secrets.ts`), and test/agentcore-secrets.test.ts holds the same contract on Node, against the
 * same stand-in. The container signs GetSecretValue with `@smithy/signature-v4` over its own hash; the stand-in checks
 * the signature with a computation of its own.
 */
import { applyRuntimeSecrets } from "../../src/deploy/agentcore/runtime-secrets.ts";
import { awsStandIn } from "../aws-stand-in.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/runtime-secrets.ts");

const failures: string[] = [];
function check(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures.push(label);
}

const ARN = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:fastagent/bot-AbCdEf";
const realFetch = globalThis.fetch;

{
  const aws = awsStandIn(ARN, '{"MODEL_KEY":"from-secret","OTHER":"from-secret"}');
  globalThis.fetch = aws.fetch;
  const env: NodeJS.ProcessEnv = { FASTAGENT_SECRET_ARN: ARN, OTHER: "platform" };
  await applyRuntimeSecrets(env);
  check(
    "a signed GetSecretValue is accepted, and its values reach the environment but for what the platform set",
    aws.problems.length === 0 && env.MODEL_KEY === "from-secret" && env.OTHER === "platform",
    `${JSON.stringify(aws.problems)} ${JSON.stringify(env)}`,
  );
  check(
    "the metadata service is asked for a token, a role, its credentials, then Secrets Manager",
    aws.calls.length === 4,
    aws.calls.join(", "),
  );
}
{
  globalThis.fetch = awsStandIn(ARN, "{}", "another-secret-key").fetch;
  const failure = await applyRuntimeSecrets({ FASTAGENT_SECRET_ARN: ARN }).then(
    () => undefined,
    (error: unknown) => String(error),
  );
  check(
    "a signature the service would refuse is a failure that says so",
    /answered 403: signature mismatch/.test(failure ?? ""),
    String(failure),
  );
}
globalThis.fetch = realFetch;

if (failures.length > 0) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
process.exit(0);
