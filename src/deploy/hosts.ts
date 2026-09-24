/**
 * The deploy targets, as a value: the CLI's `<host>` choices and the host-only-flag table's
 * exhaustiveness check both read it. Dependency-free, so `cli/program.ts` can import it at load
 * time without pulling a command module.
 *
 * ── ADDING A HOST ───────────────────────────────────────────────────────────
 *
 * Three edits: a directory beside this file (copy `fly/`: `plan.ts` pure, `run.ts` driving the host
 * CLI behind the runner seam), its `HostDeploy` in `cli/commands/deploy/<host>.ts` (kept-file
 * semantics, gates, the drive glue — the half that may exit the process), and its name in the array
 * below. `deploy/` itself is a neutral kernel plus one directory per host; nothing host-specific
 * belongs in the kernel, and no host may hold a fact about another one (a host-only flag is a row in
 * `HOST_ONLY_FLAGS` in `cli/commands/deploy.ts`, warning elsewhere; `--tunnel` stays a usage GATE in `runDeploy`
 * because a refusal is not a row).
 *
 * BEFORE writing one, read that host's docs for what it does NOT do implicitly — above all, whether
 * a created resource is REACHABLE without a further step. On Fly, `[http_service]` declares a service and allocates
 * no address, and v4 and v6 are separate commands, so an app with only v6 is unreachable from an IPv4-only webhook
 * sender. The host's own docs and CLI source usually say so; read them before a real deploy has to.
 *
 * And when a driver PARSES what a host CLI printed: the judgement must match the GRANULARITY of the
 * action it drives (one question per command), and "we could not read the host" is a third answer,
 * never "absent".
 */
export const DEPLOY_HOSTS = ["docker", "fly", "railway", "agentcore"] as const;

export type DeployHost = (typeof DEPLOY_HOSTS)[number];
