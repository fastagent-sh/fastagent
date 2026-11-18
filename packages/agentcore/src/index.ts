/**
 * What running on Amazon Bedrock AgentCore needs: the runtime a container serves, Aurora DSQL as its database, and the
 * EventBridge Scheduler group its session alarms run in. A Caller connects through `@fastagent-sh/client/agentcore`.
 */
export { type AlarmGroup, type AlarmGroupOptions, createAlarmGroup } from "./alarms.ts";
export { DSQL_LIMITS, type DsqlOptions, createIndexAsync, dsqlDatabase } from "./dsql.ts";
export { type AgentCoreOptions, serveAgentCore } from "./runtime.ts";
