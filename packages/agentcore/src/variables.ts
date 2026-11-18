/** What the AWS resources tell the container (`cdk.ts`) and the container reads (`cli.ts`): one place for both. */

/** The Aurora DSQL cluster the instances are in. */
export const DSQL_ENDPOINT_ENV = "FASTAGENT_DSQL_ENDPOINT";

/** The Secrets Manager secret, by name, whose JSON object holds the agent's values. */
export const SECRETS_ENV = "FASTAGENT_SECRETS";

/** A PostgreSQL database instead of DSQL: an image run off AWS, on a machine of one's own. */
export const DATABASE_URL_ENV = "FASTAGENT_DATABASE_URL";
