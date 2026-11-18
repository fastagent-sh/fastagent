/**
 * The agent's values from the Secrets Manager secret its runtime names (`FASTAGENT_SECRETS`): one JSON object of names
 * to strings, read with the runtime's role as an instance opens. A name the container's environment also sets is
 * refused, since which of the two the agent would read is not a choice to make silently. A read Secrets Manager refuses
 * for a moment (throttled, its own fault, the network) is {@link Unavailable}; one it refuses for good (no such secret,
 * no permission) is not.
 */
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Unavailable } from "@fastagent-sh/fastagent/platform";

export async function secretValues(
  secretName: string,
  environment: Readonly<Record<string, string | undefined>>,
  client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
): Promise<Record<string, string>> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretName })).catch((error) => {
    const { name, $fault } = error as { name?: string; $fault?: string };
    const passing = $fault === "server" || name === "ThrottlingException" || name === "TimeoutError";
    throw new (passing ? Unavailable : Error)(`the secret ${secretName} cannot be read: ${(error as Error).message}`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(SecretString ?? "");
  } catch {
    throw new Error(`the secret ${secretName} is not a JSON object of names to values`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the secret ${secretName} is not a JSON object of names to values`);
  }
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string")
      throw new Error(`the secret ${secretName} has ${name} as a ${typeof value}, not a string`);
    if (environment[name] !== undefined) {
      throw new Error(`${name} is both in the secret ${secretName} and in the runtime's environment: keep it in one`);
    }
    values[name] = value;
  }
  return values;
}
