import { describe, expect, it } from "vitest";
import { planK8sDeploy, toK8sName, k8sSecretYaml } from "../src/deploy/k8s/plan.ts";

const artifact = (p: ReturnType<typeof planK8sDeploy>, path: string) =>
  p.artifacts.find((a) => a.path === path)?.content ?? "";
const runbook = (p: ReturnType<typeof planK8sDeploy>) => p.runbook.join("\n");

/** Defaults for the fields a test doesn't care about (a code workspace with a lockfile). */
const base = {
  name: "bot",
  port: 8787,
  hasPackageJson: true,
  runtime: "node",
  hasLockfile: true,
  version: "9.9.9",
  hasTimeTriggers: false,
} as const;

describe("deploy/k8s: planK8sDeploy", () => {
  it("generates the manifest set + the shared portable container; Ingress only with --host", () => {
    const p = planK8sDeploy({ ...base, modelAuth: undefined, channels: [] });
    expect(p.artifacts.map((a) => a.path)).toEqual([
      "k8s/kustomization.yaml",
      "k8s/namespace.yaml",
      "k8s/pvc.yaml",
      "k8s/deployment.yaml",
      "k8s/service.yaml",
      "Dockerfile",
      ".dockerignore",
    ]);
    expect(artifact(p, "k8s/kustomization.yaml")).not.toContain("ingress.yaml");

    const withHost = planK8sDeploy({ ...base, modelAuth: undefined, channels: [], host: "agent.example.com" });
    expect(withHost.artifacts.map((a) => a.path)).toContain("k8s/ingress.yaml");
    expect(artifact(withHost, "k8s/kustomization.yaml")).toContain("ingress.yaml");
    expect(artifact(withHost, "k8s/ingress.yaml")).toContain("host: agent.example.com");
  });

  it("deployment encodes the single-machine contract: 1 replica, Recreate, state on the PVC at /data", () => {
    const p = planK8sDeploy({ ...base, modelAuth: undefined, channels: [] });
    const d = artifact(p, "k8s/deployment.yaml");
    expect(d).toContain("replicas: 1");
    expect(d).toContain("type: Recreate"); // two pods must never share /data
    expect(d).toContain("name: FASTAGENT_STATE_DIR");
    expect(d).toContain("value: /data");
    expect(d).toContain(`containerPort: 8787`);
    expect(d).toContain(`value: "8787"`); // PORT
    expect(d).toContain("path: /health"); // readiness + liveness
    expect(d).toContain("name: fastagent-secrets"); // envFrom the one Secret
    // The PVC enforces the single consumer at the storage layer too.
    expect(artifact(p, "k8s/pvc.yaml")).toContain("ReadWriteOncePod");
  });

  it("uses the --image ref in BOTH the deployment and the runbook; placeholder when absent", () => {
    const p = planK8sDeploy({ ...base, modelAuth: undefined, channels: [], image: "ghcr.io/acme/bot:v1" });
    expect(artifact(p, "k8s/deployment.yaml")).toContain("image: ghcr.io/acme/bot:v1");
    expect(runbook(p)).toContain("docker build -t ghcr.io/acme/bot:v1 .");
    expect(runbook(p)).toContain("docker push ghcr.io/acme/bot:v1");

    const placeholder = planK8sDeploy({ ...base, modelAuth: undefined, channels: [] });
    expect(artifact(placeholder, "k8s/deployment.yaml")).toContain("image: <registry>/bot:<tag>");
    expect(runbook(placeholder)).toContain("--image"); // tells the operator how to fill both at once
  });

  it("orders the runbook: build+push → namespace → secret → apply -k → rollout → webhook", () => {
    const out = runbook(
      planK8sDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"], host: "agent.example.com" }),
    );
    const order = (s: string) => out.indexOf(s);
    expect(order("docker push")).toBeLessThan(order("kubectl apply -f k8s/namespace.yaml"));
    expect(order("kubectl apply -f k8s/namespace.yaml")).toBeLessThan(order("create secret generic"));
    expect(order("create secret generic")).toBeLessThan(order("kubectl apply -k k8s/"));
    expect(order("kubectl apply -k k8s/")).toBeLessThan(order("rollout status deployment/bot"));
    expect(order("rollout status deployment/bot")).toBeLessThan(order("setWebhook"));
  });

  it("lists the required secrets (model env key + channel secrets) as one create-secret command", () => {
    const out = runbook(planK8sDeploy({ ...base, modelAuth: "OPENAI_API_KEY", channels: ["telegram"] }));
    expect(out).toContain(
      "kubectl -n bot create secret generic fastagent-secrets " +
        "--from-literal=OPENAI_API_KEY=<value> --from-literal=TELEGRAM_BOT_TOKEN=<value> " +
        "--from-literal=TELEGRAM_SECRET_TOKEN=<value>",
    );
  });

  it("turns a non-env auth label into guidance, not a secret (shared secret logic)", () => {
    for (const label of ["OAuth", "stored credential", "keychain"]) {
      const out = runbook(planK8sDeploy({ ...base, modelAuth: label, channels: [] }));
      expect(out).not.toContain(`${label}=`); // never injected as a literal secret pair
      expect(out).toContain("Model auth");
      expect(out).toContain("FASTAGENT_AUTH_SEED"); // names the --run carry path
    }
  });

  it("webhook steps: concrete URL with --host; exposure guidance without it", () => {
    const withHost = runbook(
      planK8sDeploy({ ...base, modelAuth: undefined, channels: ["telegram"], host: "agent.example.com" }),
    );
    expect(withHost).toContain("url=https://agent.example.com/telegram");

    const noHost = runbook(planK8sDeploy({ ...base, modelAuth: undefined, channels: ["telegram"] }));
    expect(noHost).toContain("https://<your-host>/telegram"); // placeholder, never a fabricated URL
    expect(noHost).toMatch(/Expose the service publicly/);
  });

  it("forbids scale-to-zero automation for github (no replay) and time triggers (no wake-up)", () => {
    expect(runbook(planK8sDeploy({ ...base, modelAuth: undefined, channels: ["github"] }))).toContain(
      "Do NOT add scale-to-zero automation",
    );
    expect(runbook(planK8sDeploy({ ...base, modelAuth: undefined, channels: [], hasTimeTriggers: true }))).toContain(
      "Do NOT add scale-to-zero automation",
    );
    // Neither present: scale-to-zero is a stated trade, not forbidden.
    expect(runbook(planK8sDeploy({ ...base, modelAuth: undefined, channels: [] }))).not.toContain(
      "Do NOT add scale-to-zero automation",
    );
  });

  it("states the single-replica floor in the runbook", () => {
    expect(runbook(planK8sDeploy({ ...base, modelAuth: undefined, channels: [] }))).toMatch(/Keep replicas at 1/);
  });

  it("kit layout (kitDir): manifests namespaced under the kit + the build points at the kit Dockerfile", () => {
    const p = planK8sDeploy({ ...base, modelAuth: undefined, channels: [], kitDir: "agent" });
    expect(p.artifacts.map((a) => a.path).sort()).toEqual([
      ".dockerignore",
      "agent/Dockerfile",
      "agent/Dockerfile.dockerignore",
      "agent/k8s/deployment.yaml",
      "agent/k8s/kustomization.yaml",
      "agent/k8s/namespace.yaml",
      "agent/k8s/pvc.yaml",
      "agent/k8s/service.yaml",
    ]);
    const out = runbook(p);
    expect(out).toContain("docker build -f agent/Dockerfile");
    expect(out).toContain("kubectl apply -k agent/k8s/");
  });
});

describe("deploy/k8s: helpers", () => {
  it("toK8sName: DNS-1123 label from a directory basename", () => {
    expect(toK8sName("My Agent")).toBe("my-agent");
    expect(toK8sName("bot")).toBe("bot");
    expect(toK8sName("42-things")).toBe("42-things"); // digits may lead (unlike a Fly app name)
    expect(toK8sName("---")).toBe("agent-0");
    expect(toK8sName("a".repeat(80)).length).toBeLessThanOrEqual(63);
  });

  it("k8sSecretYaml: JSON-quoted values (safe for base64 seeds / keys with special chars)", () => {
    const y = k8sSecretYaml("bot", { OPENAI_API_KEY: "sk-x", FASTAGENT_AUTH_SEED: "e30=" });
    expect(y).toContain("namespace: bot");
    expect(y).toContain(`OPENAI_API_KEY: "sk-x"`);
    expect(y).toContain(`FASTAGENT_AUTH_SEED: "e30="`);
    expect(y).toContain("stringData:");
  });
});
