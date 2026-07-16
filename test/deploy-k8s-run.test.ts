import { describe, expect, it, vi } from "vitest";
import { type K8sRunPlan, deployK8sRun } from "../src/deploy/k8s/run.ts";
import type { CliRunner } from "../src/deploy/runner.ts";

/** A fake kubectl: records every call, returns per-command scripted results (default code 0, empty). */
function fakeKubectl(script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) {
  const calls: { args: string[]; input?: string }[] = [];
  const kubectl: CliRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const r = script(args);
    return { code: r.code ?? 0, stdout: r.stdout ?? "" };
  };
  return { kubectl, calls, cmds: () => calls.map((c) => c.args.join(" ")) };
}

const plan = (over: Partial<K8sRunPlan> = {}): K8sRunPlan => ({
  name: "bot",
  manifestsDir: "k8s",
  image: "ghcr.io/acme/bot:v1",
  host: undefined,
  secrets: {},
  missingSecrets: [],
  channels: [],
  ...over,
});

/** Default script: a context exists; everything else succeeds. */
const withContext = (script: (args: string[]) => { code?: number; stdout?: string } = () => ({})) => {
  return (a: string[]) => (a[0] === "config" ? { stdout: "prod-cluster\n" } : script(a));
};

const run = (p: K8sRunPlan, kubectl: CliRunner, tg = vi.fn(async () => {})) => deployK8sRun(p, kubectl, () => {}, tg);

describe("deploy/k8s/run: the coding-agent deploy journey", () => {
  it("happy path: context → namespace → secret → apply -k → rollout → telegram webhook (with --host)", async () => {
    const { kubectl, cmds } = fakeKubectl(withContext());
    const tg = vi.fn(async () => {});
    const out = await run(
      plan({
        host: "agent.example.com",
        channels: ["telegram"],
        secrets: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_SECRET_TOKEN: "s" },
      }),
      kubectl,
      tg,
    );

    expect(out).toEqual({ ok: true, url: "https://agent.example.com" });
    expect(cmds()).toEqual([
      "config current-context",
      "apply -f -", // namespace (stdin)
      "apply -f -", // secret (stdin)
      "apply -k k8s",
      "rollout status deployment/bot -n bot --timeout=180s",
    ]);
    expect(tg).toHaveBeenCalledWith("https://agent.example.com");
  });

  it("secret values go over stdin as one manifest, never argv", async () => {
    const { kubectl, calls } = fakeKubectl(withContext());
    await run(plan({ secrets: { OPENAI_API_KEY: "sk-x", FASTAGENT_AUTH_SEED: "b64" } }), kubectl);
    const applies = calls.filter((c) => c.args[0] === "apply" && c.args.includes("-f"));
    expect(applies).toHaveLength(2); // namespace + secret
    const secretApply = applies[1]!;
    expect(secretApply.args.join(" ")).not.toContain("sk-x"); // not in argv
    expect(secretApply.input).toContain(`OPENAI_API_KEY: "sk-x"`); // on stdin
    expect(secretApply.input).toContain("namespace: bot");
  });

  it("skips the secret apply when there is nothing to set (auth.json on the volume, no channels)", async () => {
    const { kubectl, cmds } = fakeKubectl(withContext());
    const out = await run(plan(), kubectl);
    expect(out).toEqual({ ok: true });
    expect(cmds()).toEqual([
      "config current-context",
      "apply -f -", // namespace only
      "apply -k k8s",
      "rollout status deployment/bot -n bot --timeout=180s",
    ]);
  });

  it("no --host: completes without a URL and never calls the webhook registrar", async () => {
    const { kubectl } = fakeKubectl(withContext());
    const tg = vi.fn(async () => {});
    const out = await run(plan({ channels: ["telegram"], secrets: { TELEGRAM_BOT_TOKEN: "t" } }), kubectl, tg);
    expect(out).toEqual({ ok: true });
    expect(tg).not.toHaveBeenCalled();
  });

  it("gate: a missing secret value stops before any side effect", async () => {
    const { kubectl, cmds } = fakeKubectl();
    const out = await run(plan({ missingSecrets: ["TELEGRAM_BOT_TOKEN"] }), kubectl);
    expect(out).toEqual({ ok: false, gate: expect.stringContaining("TELEGRAM_BOT_TOKEN") });
    expect(cmds()).toEqual([]); // nothing ran
  });

  it("gate: no --image stops before any side effect (the cluster can only pull)", async () => {
    const { kubectl, cmds } = fakeKubectl();
    const out = await run(plan({ image: undefined }), kubectl);
    expect(out).toEqual({ ok: false, gate: expect.stringContaining("--image") });
    expect(cmds()).toEqual([]);
  });

  it("gate: no kubectl context (failed or empty) → stops before any apply", async () => {
    for (const result of [{ code: 1 }, { stdout: "" }, { stdout: "  \n" }]) {
      const { kubectl, cmds } = fakeKubectl((a) => (a[0] === "config" ? result : {}));
      const out = await run(plan(), kubectl);
      expect(out).toEqual({ ok: false, gate: expect.stringMatching(/kubectl context/) });
      expect(cmds()).toEqual(["config current-context"]); // read-only, then stop
    }
  });

  it("gate: namespace apply failure names cluster access", async () => {
    const { kubectl } = fakeKubectl(withContext((a) => (a.includes("-f") ? { code: 1 } : {})));
    const out = await run(plan(), kubectl);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/cluster access/) });
  });

  it("gate: apply -k failure surfaces (fix and re-run)", async () => {
    const { kubectl } = fakeKubectl(withContext((a) => (a.includes("-k") ? { code: 1 } : {})));
    const out = await run(plan(), kubectl);
    expect(out).toEqual({ ok: false, gate: expect.stringMatching(/apply -k/) });
  });

  it("gate: a stalled rollout names the ImagePullBackOff remediation (the common push miss)", async () => {
    const { kubectl } = fakeKubectl(withContext((a) => (a[0] === "rollout" ? { code: 1 } : {})));
    const out = await run(plan(), kubectl);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.gate).toContain("ImagePullBackOff");
  });
});
