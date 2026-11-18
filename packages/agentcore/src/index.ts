/**
 * What running on Amazon Bedrock AgentCore needs: the runtime a container serves, and Aurora DSQL as its database.
 * A Caller's side, `connectAgentCore`, is `@fastagent-sh/agentcore/client`: it loads no runtime.
 */
export { type AlarmGroup, type AlarmGroupOptions, createAlarmGroup } from "./alarms.ts";
export { DSQL_LIMITS, type DsqlOptions, createIndexAsync, dsqlDatabase } from "./dsql.ts";
export { type AgentCoreOptions, serveAgentCore } from "./runtime.ts";
