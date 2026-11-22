/** What the AWS resources tell the container (`cdk.ts`) and the container reads (`cli.ts`): one place for both. */

/** The Aurora DSQL cluster the instances are in. */
export const DSQL_ENDPOINT_ENV = "FASTAGENT_DSQL_ENDPOINT";

/** The Secrets Manager secret, by name, whose JSON object holds the agent's values. */
export const SECRETS_ENV = "FASTAGENT_SECRETS";

/** The runtime ARN `fastagent agentcore invoke` targets when `--arn` is omitted. */
export const AGENTCORE_ARN_ENV = "FASTAGENT_AGENTCORE_ARN";
