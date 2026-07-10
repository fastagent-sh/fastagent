/**
 * `fastagent deploy k8s` — the Kubernetes deploy PLAN, computed from the resolved definition. Pure:
 * facts in, artifact contents + an ordered runbook out; the CLI writes the files and prints the runbook.
 *
 * Kubernetes is the third target, and it differs from Fly/Railway in kind, not just shape: it is a
 * CONTROL PLANE, not a host — fastagent cannot create machines, mint URLs, or build images there.
 * Three asymmetries drive this module:
 *
 *  1. The image is the operator's. Fly/Railway build from the Dockerfile on their builders; a cluster
 *     only PULLS a pushed image, so the plan takes an `--image` ref (placeholder when omitted) and the
 *     runbook starts with build+push. `--run` assumes the image is already pushed.
 *
 *  2. The constraints ARE the manifests. Fly encodes single-machine/volume/scale policy in fly.toml;
 *     on Kubernetes the same contract is expressed as `replicas: 1` + `strategy: Recreate` + a
 *     `ReadWriteOncePod` PVC at /data + `FASTAGENT_STATE_DIR=/data`. Kustomize (`kubectl apply -k`)
 *     orders the namespace before the namespaced resources.
 *
 *  3. The public URL is cluster-specific. There is no `<app>.fly.dev`; ingress + TLS live outside the
 *     workload (an ingress controller + cert-manager or the cluster's own edge), so the Ingress is
 *     generated only when `--host` names the public host, and TLS is stated as a manual, cluster-owned
 *     step (like Railway's App Sleeping — named honestly, not hidden).
 *
 * What IS shared with Fly/Railway comes from the neutral modules: the container (Dockerfile +
 * .dockerignore) and the required-secret list. Secrets are NEVER written into a manifest artifact —
 * the runbook creates them with `kubectl create secret` (values from the local .env), and `--run`
 * applies them over stdin.
 */
import type { ChannelKind } from "../../scaffold/add-channel.ts";
import { type Artifact, type ContainerInput, containerArtifacts } from "../container.ts";
import { isEnvKey, requiredSecrets } from "../secrets.ts";

/** State root = the PVC mount path, kept in lockstep. `/data` matches the Fly/Railway recipes. */
const MOUNT = "/data";

/** The one Secret every manifest references — fixed within the per-agent namespace. */
export const K8S_SECRET_NAME = "fastagent-secrets";

export interface K8sPlanInput extends ContainerInput {
  // Container facts (hasPackageJson, runtime, hasLockfile, bunVersion, version, apt) come from
  // ContainerInput — ONE source, so the plan and the generated Dockerfile can't drift.
  /** DNS-1123 name used for the namespace AND the resources; the CLI slugs it from the dir basename. */
  name: string;
  /** Image ref the Deployment runs (`ghcr.io/acme/bot:v1`). Absent → a placeholder + a runbook warning
   *  (the cluster can only pull a pushed image; fastagent never builds/pushes). */
  image?: string;
  /** Public https host (`agent.example.com`) — enables the Ingress artifact + concrete webhook steps.
   *  Absent → no Ingress; webhook steps state the manual exposure requirement. */
  host?: string;
  /** The port the app listens on (config.http.port ?? 8787); Service/probes route to it. */
  port: number;
  /** What satisfies model auth locally ({@link probeAuthSource}): an env-var name, an OAuth/stored
   *  label, or undefined (unconfigured). */
  modelAuth: string | undefined;
  /** Channels discovered in the workspace — each contributes its required secrets + webhook step. */
  channels: ChannelKind[];
  /** Extra secret env-var names (fastagent.config deploy.secrets) — added to the runbook's secret list. */
  extraSecrets?: string[];
  /** Time triggers present (schedules/ or selfSchedule) — the runbook forbids scale-to-zero automation:
   *  cron/wake has no external wake-up, so a scaled-down pod sleeps through them. */
  hasTimeTriggers: boolean;
}

export interface K8sPlan {
  /** k8s/*.yaml + Dockerfile/.dockerignore — written by the CLI (skipped if present unless --force). */
  artifacts: Artifact[];
  /** The ordered, values-resolved deploy runbook — printed to stdout for the coding agent to execute. */
  runbook: string[];
}

/** Sanitize a directory basename into a DNS-1123 label (namespace/resource names): lowercase,
 *  [a-z0-9-], alphanumeric at both ends, ≤ 63 chars. */
export function toK8sName(basename: string): string {
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : `agent-${slug || "0"}`.slice(0, 63);
}

/** The Namespace manifest — exported for `--run`, which applies it BEFORE the secret (its home). */
export function k8sNamespaceYaml(name: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${name}
`;
}

/**
 * The Secret manifest `--run` applies over stdin (values never in an artifact or argv). JSON-quoted
 * values: valid YAML scalars regardless of content (a base64 FASTAGENT_AUTH_SEED, a key with `#`).
 */
export function k8sSecretYaml(name: string, data: Record<string, string>): string {
  const entries = Object.entries(data)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${K8S_SECRET_NAME}
  namespace: ${name}
type: Opaque
stringData:
${entries}
`;
}

function pvcYaml(name: string): string {
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}-state
  namespace: ${name}
spec:
  # ReadWriteOncePod hard-guarantees a single consuming pod (needs CSI support); if your storage
  # class rejects it, use ReadWriteOnce — replicas: 1 + strategy Recreate still keep a single writer.
  accessModes:
    - ReadWriteOncePod
  resources:
    requests:
      storage: 1Gi
`;
}

function deploymentYaml(name: string, image: string, port: number): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${name}
spec:
  replicas: 1                  # single-machine tier: state lives on ONE volume — do not scale past 1
  strategy:
    type: Recreate             # stop the old pod before starting the new — two pods must never share ${MOUNT}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      securityContext:
        fsGroup: 1000          # make the ${MOUNT} volume writable (node/bun images run uid/gid 1000)
      containers:
        - name: agent
          image: ${image}
          ports:
            - name: http
              containerPort: ${port}
          env:
            - name: PORT
              value: "${port}"
            - name: FASTAGENT_STATE_DIR
              value: ${MOUNT}  # the ONE machine-state root — auth, sessions, channel state
          envFrom:
            - secretRef:
                name: ${K8S_SECRET_NAME}
                # optional: a missing secret surfaces at startup (auth report) / the first turn,
                # instead of blocking the pod forever in CreateContainerConfigError.
                optional: true
          volumeMounts:
            - name: state
              mountPath: ${MOUNT}
          readinessProbe:
            httpGet:
              path: /health
              port: http
          livenessProbe:
            httpGet:
              path: /health
              port: http
            initialDelaySeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              memory: 1Gi
      volumes:
        - name: state
          persistentVolumeClaim:
            claimName: ${name}-state
`;
}

function serviceYaml(name: string): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${name}
spec:
  selector:
    app: ${name}
  ports:
    - name: http
      port: 80
      targetPort: http
`;
}

function ingressYaml(name: string, host: string): string {
  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${name}
  namespace: ${name}
  # TLS is cluster-owned (webhooks require https). With cert-manager, uncomment BOTH the annotation
  # and the tls block below; otherwise terminate TLS your cluster's way (cloud LB, edge proxy, …).
  # annotations:
  #   cert-manager.io/cluster-issuer: <your-issuer>
spec:
  # ingressClassName: nginx   # set when the cluster has no default ingress class
  # tls:
  #   - hosts: [${host}]
  #     secretName: ${name}-tls
  rules:
    - host: ${host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${name}
                port:
                  number: 80
`;
}

function kustomizationYaml(hasIngress: boolean): string {
  const resources = ["namespace.yaml", "pvc.yaml", "deployment.yaml", "service.yaml"];
  if (hasIngress) resources.push("ingress.yaml");
  return `# Apply with \`kubectl apply -k\` — kustomize orders the namespace before the namespaced resources.
resources:
${resources.map((r) => `  - ${r}`).join("\n")}
`;
}

/** Compute the Kubernetes deploy plan from the resolved definition. */
export function planK8sDeploy(input: K8sPlanInput): K8sPlan {
  const { name, host, port, modelAuth, channels, kitDir } = input;
  // No pushed image known at plan time → a placeholder the operator fills (deployment.yaml + runbook
  // step 1 name the same ref, so editing one line fixes both).
  const image = input.image ?? `<registry>/${name}:<tag>`;
  // Kit layout: the manifests are namespaced under the kit (agent/k8s/) like fly.toml/railway.json,
  // so they never collide with the host repo's own manifests.
  const dir = kitDir ? `${kitDir}/k8s` : "k8s";
  const artifacts: Artifact[] = [
    { path: `${dir}/kustomization.yaml`, content: kustomizationYaml(host !== undefined) },
    { path: `${dir}/namespace.yaml`, content: k8sNamespaceYaml(name) },
    { path: `${dir}/pvc.yaml`, content: pvcYaml(name) },
    { path: `${dir}/deployment.yaml`, content: deploymentYaml(name, image, port) },
    { path: `${dir}/service.yaml`, content: serviceYaml(name) },
    ...(host !== undefined ? [{ path: `${dir}/ingress.yaml`, content: ingressYaml(name, host) }] : []),
    ...containerArtifacts(input),
  ];

  const secrets = requiredSecrets(modelAuth, channels, input.extraSecrets);

  const buildCmd = kitDir ? `docker build -f ${kitDir}/Dockerfile -t ${image} .` : `docker build -t ${image} .`;
  const runbook: string[] = [
    `# Deploy "${name}" to a Kubernetes cluster. ${dir}/ manifests + Dockerfile(.dockerignore) are generated above.`,
    `# Prereqs: kubectl pointed at the target cluster (\`kubectl config current-context\`), a registry the`,
    `# cluster can pull from, and — for webhook channels — an ingress controller + TLS on the cluster.`,
    ``,
    `# 1. Build + push the image. The cluster only PULLS: fastagent never builds there. The ref below`,
    `#    must match \`image:\` in ${dir}/deployment.yaml${input.image ? "" : " — pass --image <registry>/<name>:<tag> to fill both"}.`,
    buildCmd,
    `docker push ${image}`,
    ``,
    `# 2. One-time setup: namespace + secret (values from your local .env — never baked into the image).`,
    `kubectl apply -f ${dir}/namespace.yaml`,
  ];

  if (secrets.length > 0) {
    runbook.push(
      `# Secrets (replace each <value>):`,
      ...secrets.map((s) => `#   ${s.name}: ${s.hint}`),
      `kubectl -n ${name} create secret generic ${K8S_SECRET_NAME} ${secrets
        .map((s) => `--from-literal=${s.name}=<value>`)
        .join(" ")}`,
    );
  }

  // Model-auth guidance: an env key becomes a secret above. Otherwise the plan can't read the local
  // credential's value (OAuth or a stored key) — same wording discipline as the Fly/Railway plans.
  if (!isEnvKey(modelAuth)) {
    runbook.push(
      modelAuth === undefined
        ? `# Model auth: none found at the local auth path — a global \`fastagent login\` isn't read here; pass --auth-path <file> (e.g. ~/.fastagent/auth.json), or \`--run\` carries it automatically.`
        : `# Model auth: your local auth is "${modelAuth}" — the plan can't read its value to set as a secret.`,
      `#   Add your provider API key to the ${K8S_SECRET_NAME} secret, OR place auth.json on the ${MOUNT} volume`,
      `#   (kubectl cp into the running pod), OR \`--run\` carries the login as FASTAGENT_AUTH_SEED.`,
    );
  }

  runbook.push(
    ``,
    `# 3. Deploy. A REDEPLOY is: push a new tag, update image: in ${dir}/deployment.yaml, re-run these two:`,
    `kubectl apply -k ${dir}/`,
    `kubectl -n ${name} rollout status deployment/${name}`,
  );

  // The fastagent-only post-step: point each channel's webhook at the live URL. With --host the URL is
  // concrete; without it the exposure (ingress/LB + TLS) is the operator's cluster-specific step.
  const base = host !== undefined ? `https://${host}` : "https://<your-host>";
  const post: string[] = [];
  if (host === undefined && channels.length > 0) {
    post.push(
      `# Expose the service publicly over https first (ingress + TLS — re-run with --host <domain> to`,
      `# generate the Ingress), then register each webhook against that URL:`,
    );
  }
  if (channels.includes("telegram")) {
    post.push(
      `# Register the Telegram webhook (default route POST /telegram; if you remapped it in`,
      `# channels/telegram.ts, use your path). secret_token MUST equal TELEGRAM_SECRET_TOKEN:`,
      `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\`,
      `  -d url=${base}/telegram -d secret_token=<TELEGRAM_SECRET_TOKEN>`,
    );
  }
  if (channels.includes("github")) {
    post.push(
      `# Set the GitHub webhook (repo Settings → Webhooks). Default route POST /webhook; if you remapped it`,
      `# in channels/github.ts, use your path:`,
      `#   Payload URL = ${base}/webhook, content type application/json, secret = GITHUB_WEBHOOK_SECRET`,
    );
  }
  if (post.length > 0) runbook.push(``, ...post);

  // Scale policy: Kubernetes does not scale to zero by itself, but autoscaling add-ons (HPA/KEDA) and
  // "scale down when idle" habits exist — name the constraint like the Fly/Railway plans do.
  runbook.push(
    ``,
    channels.includes("github")
      ? `# Do NOT add scale-to-zero automation (KEDA etc.) — github turns have no replay, a scale-down mid-review is lost.`
      : input.hasTimeTriggers
        ? `# Do NOT add scale-to-zero automation (KEDA etc.) — schedules/wake-ups have no external wake-up; a scaled-down pod sleeps through them.`
        : `# Scale-to-zero: not built into Kubernetes; if you add it (KEDA etc.), note that in-flight HTTP turns are lost on scale-down.`,
    `# Keep replicas at 1: the PVC (and all state on it) is tied to one pod; extra replicas split state`,
    `# (the manifests enforce it via strategy Recreate + a ReadWriteOncePod access mode).`,
  );

  return { artifacts, runbook };
}
