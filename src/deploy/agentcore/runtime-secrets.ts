/**
 * What the AgentCore container does with its deployment's values: read the Secrets Manager secret `FASTAGENT_SECRET_ARN`
 * names and put each name it holds into the environment (agent-artifact.md §6.2).
 *
 * The runtime has no way to reference a secret from an environment variable, so the container reads it itself, on its
 * first invocation. Its credentials are the execution role's, from the microVM's instance-metadata service (IMDSv2); the
 * request is SigV4-signed with the signer `shell.ts` already uses, so no AWS SDK is installed in the image.
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { SECRET_ARN_ENV } from "./plan.ts";
import { Sha256 } from "./sigv4.ts";

const IMDS = "http://169.254.169.254/latest";
const TIMEOUT_MS = 5_000;

interface RoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

async function imdsText(url: string, init: RequestInit): Promise<string> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} answered ${response.status}`);
  return response.text();
}

/** The execution role's credentials, as the metadata service hands them to the microVM. */
async function roleCredentials(): Promise<RoleCredentials> {
  const token = await imdsText(`${IMDS}/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" },
  });
  const headers = { "x-aws-ec2-metadata-token": token };
  const role = (await imdsText(`${IMDS}/meta-data/iam/security-credentials/`, { headers })).trim();
  const parsed: unknown = JSON.parse(await imdsText(`${IMDS}/meta-data/iam/security-credentials/${role}`, { headers }));
  const { AccessKeyId, SecretAccessKey, Token } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof AccessKeyId !== "string" || typeof SecretAccessKey !== "string" || typeof Token !== "string") {
    throw new Error(`the metadata service's credentials for ${role} are not an access key, a secret and a token`);
  }
  return { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: Token };
}

/** `arn:<partition>:secretsmanager:<region>:<account>:secret:<name>-<suffix>` → its region. */
function regionOf(secretArn: string): string {
  const [, , service, region] = secretArn.split(":");
  if (service !== "secretsmanager" || !region) throw new Error(`${SECRET_ARN_ENV} is not a Secrets Manager ARN`);
  return region;
}

/** The secret's JSON object, every value a string. */
async function readSecretValues(secretArn: string): Promise<Record<string, string>> {
  const region = regionOf(secretArn);
  const hostname = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretArn });
  const signed = await new SignatureV4({
    service: "secretsmanager",
    region,
    credentials: await roleCredentials(),
    sha256: Sha256,
  }).sign({
    method: "POST",
    protocol: "https:",
    hostname,
    path: "/",
    body,
    headers: {
      host: hostname,
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
  });
  const response = await fetch(`https://${hostname}/`, {
    method: "POST",
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = await response.text();
  // Never the parser's message: it quotes the text around the error, and this document holds every value.
  if (!response.ok) throw new Error(`GetSecretValue answered ${response.status}: ${answer.slice(0, 200)}`);
  let values: unknown;
  try {
    values = JSON.parse((JSON.parse(answer) as { SecretString?: string }).SecretString ?? "");
  } catch {
    throw new Error(`the secret ${secretArn} is not a JSON object of values`);
  }
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(`the secret ${secretArn} is not a JSON object of values`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string") throw new Error(`the secret ${secretArn}: ${name} is not a string`);
  }
  return values as Record<string, string>;
}

/**
 * Put the secret's values into `env`, unless the platform set the name itself (the platform's variables win, as they do
 * over a value file anywhere). Without `FASTAGENT_SECRET_ARN` there is nothing to read.
 */
export async function applyRuntimeSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const arn = env[SECRET_ARN_ENV];
  if (!arn) return;
  let values: Record<string, string>;
  try {
    values = await readSecretValues(arn);
  } catch (error) {
    throw new Error(
      `could not read the deployment's values from ${arn}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const [name, value] of Object.entries(values)) if (!(name in env)) env[name] = value;
}
