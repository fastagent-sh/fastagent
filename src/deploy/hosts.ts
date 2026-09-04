/** The deploy targets, as a value: the CLI's `<host>` choices and the host-only-flag table's
 *  exhaustiveness check both read it. Dependency-free, so `cli/program.ts` can import it at load
 *  time without pulling a command module. */
export const DEPLOY_HOSTS = ["docker", "fly", "railway", "agentcore"] as const;

export type DeployHost = (typeof DEPLOY_HOSTS)[number];
