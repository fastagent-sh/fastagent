/**
 * `fastagent deploy k8s --run` — drive kubectl to completion. The middle of the deploy the plain
 * runbook hands to the operator; `--run` executes it so a coding agent runs ONE command.
 *
 * Kubernetes' model forces differences from the Fly/Railway runners:
 *
 *  - **The image must already be pushed.** A cluster only pulls; fastagent has no builder to drive
 *    (unlike `fly deploy --remote-only` / `railway up`). `--run` therefore GATES on a missing `--image`
 *    ref, and a rollout stuck on ImagePullBackOff gates with the push remediation.
 *  - **The target is the current kubectl context** — there is no name to create; the run refuses to
 *    proceed without one (an empty context would otherwise fail with kubectl's own opaque error).
 *  - **Everything is `kubectl apply` (idempotent by construction)**: namespace first (the secret's
 *    home), then the secret over stdin (values never in argv or an artifact), then the manifests via
 *    `-k`, then `rollout status` as the readiness gate.
 *  - **The public URL is the operator's** (ingress/TLS are cluster-owned): the webhook step runs only
 *    when `--host` names it; otherwise the run finishes and states the manual step.
 *
 * kubectl is behind the shared {@link CliRunner} seam — production spawns `kubectl`, tests inject a
 * fake that records the command sequence and scripts outputs.
 */
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import type { CliRunner } from "../runner.ts";
import { k8sNamespaceYaml, k8sSecretYaml } from "./plan.ts";

export interface K8sRunPlan {
  /** Namespace AND deployment name (the plan names both from the dir basename slug). */
  name: string;
  /** The manifests dir passed to `kubectl apply -k` (relative to the run cwd = the workspace dir). */
  manifestsDir: string;
  /** Pushed image ref; undefined gates (the cluster can only pull — build+push first, pass --image). */
  image: string | undefined;
  /** Public https host for the webhook step; undefined → the run states the manual step instead. */
  host: string | undefined;
  /** `KEY=value` secrets applied as one Secret manifest over stdin: model key (env auth) or
   *  `FASTAGENT_AUTH_SEED` (file auth) + channel secrets. Never on argv. */
  secrets: Record<string, string>;
  /** Required secret names with NO local value — the run gates on these before any side effect. */
  missingSecrets: string[];
  channels: ChannelKind[];
}

/** Done (with the live URL when --host named one), or a gate the operator must clear before
 *  re-running (printed + non-zero exit by the CLI). */
export type K8sRunOutcome = { ok: true; url?: string } | { ok: false; gate: string };

/**
 * Run the deploy through `kubectl`. `log` reports progress; `registerTelegram(baseUrl)` performs the
 * post-deploy webhook step (the CLI passes its telegram registrar). Every gate is fail-visible.
 */
export async function deployK8sRun(
  plan: K8sRunPlan,
  kubectl: CliRunner,
  log: (msg: string) => void,
  registerTelegram: (baseUrl: string) => Promise<void>,
): Promise<K8sRunOutcome> {
  const gate = (g: string): K8sRunOutcome => ({ ok: false, gate: g });

  // 1. Gate missing required secret VALUES before any side effect (no half-created infra).
  if (plan.missingSecrets.length > 0) {
    return gate(
      `no local value for: ${plan.missingSecrets.join(", ")} — set them in .env (or the environment) and re-run`,
    );
  }

  // 2. The image must be pushed already — fastagent has no builder to drive on a cluster.
  if (!plan.image) {
    return gate(
      "no --image — the cluster can only pull a pushed image. Build + push it (see the runbook without --run), then re-run with --image <registry>/<name>:<tag>",
    );
  }

  // 3. The deploy target is the current kubectl context; refuse an empty one up front (fail-visible)
  //    rather than let every apply fail with kubectl's own connection error.
  const ctx = await kubectl(["config", "current-context"], { capture: true });
  if (ctx.code !== 0 || ctx.stdout.trim() === "") {
    return gate(
      "no kubectl context — point kubectl at the target cluster (`kubectl config use-context <name>`), then re-run",
    );
  }
  log(`deploying to kubectl context "${ctx.stdout.trim()}"`);

  // 4. Namespace first (the secret's home). `apply` is idempotent; a failure here is the cluster-access
  //    gate (unreachable API server, no permission).
  if ((await kubectl(["apply", "-f", "-"], { input: k8sNamespaceYaml(plan.name) })).code !== 0) {
    return gate("`kubectl apply` (namespace) failed — check cluster access/permissions (kubectl output above)");
  }

  // 5. Secret — one manifest over stdin (values never on argv), BEFORE the workload so the first pod
  //    boots with its credentials.
  const keys = Object.keys(plan.secrets);
  if (keys.length > 0) {
    log(`setting secret with ${keys.length} key(s): ${keys.join(", ")}`);
    if ((await kubectl(["apply", "-f", "-"], { input: k8sSecretYaml(plan.name, plan.secrets) })).code !== 0) {
      return gate("`kubectl apply` (secret) failed — see the kubectl output above");
    }
  }

  // 6. Manifests. kustomize orders the namespace before the namespaced resources; a re-run re-applies.
  log("applying manifests…");
  if ((await kubectl(["apply", "-k", plan.manifestsDir])).code !== 0) {
    return gate("`kubectl apply -k` failed — see the kubectl output above; fix and re-run");
  }

  // 7. Readiness gate: the rollout must complete (readiness probe /health). The common stall is the
  //    image: not pushed / not pullable from the cluster.
  log("waiting for the rollout…");
  if ((await kubectl(["rollout", "status", `deployment/${plan.name}`, "-n", plan.name, "--timeout=180s"])).code !== 0) {
    return gate(
      `rollout did not complete — \`kubectl -n ${plan.name} get pods\` to inspect (ImagePullBackOff means ` +
        `the image is not pushed/pullable from the cluster); fix and re-run`,
    );
  }

  // 8. Post-deploy webhook — needs the public https URL, which is cluster-owned. With --host we can do
  //    telegram end-to-end; without it the manual step is stated, never silently skipped.
  if (plan.host) {
    const url = `https://${plan.host}`;
    if (plan.channels.includes("telegram")) {
      log("registering telegram webhook…");
      await registerTelegram(url);
    }
    if (plan.channels.includes("github")) {
      log(`github: set the webhook in the repo (Settings → Webhooks) → ${url}/webhook`);
    }
    return { ok: true, url };
  }
  if (plan.channels.length > 0) {
    log(
      "no --host: expose the service over public https (ingress + TLS), then register the webhook(s) — " +
        "see the runbook (`fastagent deploy k8s` without --run) for the exact steps",
    );
  }
  return { ok: true };
}
