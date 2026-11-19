/** What the AWS resources tell the container (`cdk.ts`) and the container reads (`cli.ts`): one place for both. */

/** The Aurora DSQL cluster the instances are in. */
export const DSQL_ENDPOINT_ENV = "FASTAGENT_DSQL_ENDPOINT";

/** The Secrets Manager secret, by name, whose JSON object holds the agent's values. */
export const SECRETS_ENV = "FASTAGENT_SECRETS";

/** The EventBridge Scheduler group holding each instance's alarm and `.deploy`. */
export const ALARM_GROUP_ENV = "FASTAGENT_ALARM_GROUP";

/** Comma-separated session ids armed on deploy without waiting for a Caller (`FastAgentResourcesProps.instances`). */
export const ALARM_INSTANCES_ENV = "FASTAGENT_ALARM_INSTANCES";

/** The runtime ARN `fastagent agentcore invoke` targets when `--arn` is omitted. */
export const AGENTCORE_ARN_ENV = "FASTAGENT_AGENTCORE_ARN";

/** The schedule in the group that holds the runtime's target and fires `{ rearm: true }` once after each deploy. */
export const DEPLOY_SCHEDULE_NAME = ".deploy";

/** The session id `.deploy` invokes: apart from every user's session, and matching `SESSION_ID_PATTERN`. */
export const DEPLOY_SESSION_ID = "fastagent-deploy-000000000000000000";
