/**
 * What running on Amazon Bedrock AgentCore needs: the runtime a container serves and Aurora DSQL as its database.
 * A Caller connects through `@fastagent-sh/agentcore/client`.
 */
export { DSQL_LIMITS, type DsqlOptions, createIndexAsync, dsqlDatabase } from "./dsql.ts";
export { type AgentCoreOptions, serveAgentCore } from "./runtime.ts";
