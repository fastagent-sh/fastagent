# Live probes

Every file here exists to check an **assumption about a system we do not own**. None of them re-runs
logic the offline suite already covers — that is what the offline suite is for. If a probe would
still pass with the third party replaced by a fake, it does not belong here.

Excluded from `npm test`. `npm run test:live` (`vitest.live.config.ts`) opts in, and a missing
credential **fails** rather than skips — you asked for them. Credentials arrive the product's way
(`FASTAGENT_AUTH_PATH` → an `auth.json`), which is what lets an OAuth-only provider be the model.

Running these LOCALLY against the same grant CI holds will break CI: an OAuth refresh voids the token
the other copy still has. Give a local run its own (`FASTAGENT_AUTH_PATH=… fastagent login`), which is
also what `.github/workflows/live.yml` does for CI.

## Two rules

**Drive a product entry, observe from outside it.** `createPiAgentFromDir`, `deploy docker --run`,
`deploy fly --run`, `deploy railway --run`, `npm install`, `startCloudflareTunnel`, `startSchedules`,
`registerTelegramWebhook`, `registerFeishuWebhook`, `createSlackApi`. A probe that rebuilds the
assembly to get a better observation point measures the rebuild, and the entry's own steps
(`installProxyFetch`, credential resolution, pinning pi's agent dir) go missing one at a time. Unit
tests elsewhere DO reach into that layer, correctly — the rule is this directory's, because only
these files claim to report on the real thing.

The two read-only CLI probes (`fly`, `railway`) are the deliberate exception: they check what a real
host CLI prints against the driver's **parsing** assumptions (`listHasName`, `ingressAddresses`,
`isLinked`, `linkedName`, `parseHasVolume`) — the belief a faked `CliRunner` cannot test.

**A probe's fixture is its specification**, not boilerplate to copy from the file next door. Fly and
Railway have one topology whatever the definition says; AgentCore's is a *function* of it
(`needsForwarder` — a webhook channel, a schedule, or `selfSchedule` — decides whether a forwarder, a
Function URL, EventBridge rules and the artifact bucket exist at all). Three copied lines of
persona+config landed on the small side, so both agentcore probes spent a release describing a
deployment neither performed: 98 lines of template validated while the comment claimed 900, and a
teardown deleting three things where two were created. Reading what the product CAN do is not reading
what YOUR INPUT makes it do. The cheap check is countable without deploying anything: what teardown
removes must match what the fixture's branch actually creates.

## What each probe checks

| Probe | The assumption |
|---|---|
| `registry` | the published tarball |
| `model` | a real provider's stream and its errors |
| `docker` | a real container build + boot + state volume |
| `tunnel` | a real Quick Tunnel carrying a request home |
| `schedule` | a cron on disk firing a real turn, settling its claim, and logging what it said |
| `telegram`, `feishu` | Telegram VERIFYING a webhook URL it was handed; Feishu CALLING one with a challenge. Registration only — delivery needs a human to type |
| `slack` | Slack's Bot API answering our pipeline. OUTBOUND only: the inbound half needs a 12h App Configuration Token, which no nightly can hold |
| `fly` | `flyctl` still prints what the Fly driver reads (read-only) |
| `fly-deploy` | a REAL Fly app provisioned then destroyed — how #425 was found: a deploy whose every step succeeded, serving on a URL that had no IP |
| `railway` | the `railway` CLI still prints what its driver reads (read-only). Also the file that dates the "Verified against CLI 5.15.0" claims in `run.ts` |
| `railway-deploy` | a REAL Railway project provisioned and destroyed — the only way to observe `railway domain`, which MINTS one when absent |
| `agentcore` | CloudFormation ACCEPTING the YAML this repo emits by hand, forwarder and schedule branches included (read-only, free, and the only check that the template parses). Also what a missing stack SAYS, in both directions through `isMissingStack` — the wording that decides whether a deploy warns it is about to replace the agent's memory |
| `agentcore-deploy` | a REAL stack + ECR repo + S3 bucket provisioned and destroyed. No public URL exists, so it proves the deployment works through `InvokeAgentRuntime`. Teardown is THREE places because the repo and runtime-created wake alarms live outside the stack on purpose, and it is ONE shared function in `env.ts` because a second copy of cleanup code drifts where nobody looks |
| `agentcore-schedule` | a REAL EventBridge cron delivering to the container: that the container ACCEPTS the fire end to end (cold start, opened definition and model turn all inside one invocation) and runs the occurrence the clock named. Measured 2026-09-20: 7/7 deliveries `200 {"fired":true}`, every `slot` equal to the `<aws.scheduler.scheduled-time>` sent, 61.4s for the cold one and 23.5–24.5s in steady state — so the delivery always arrives AFTER its instant, which is what `POST /run`'s no-tolerance future-slot rule needs |
| `agentcore-wake` | an agent SCHEDULING ITSELF on a host with no resident process: the wake tool's write becomes a POST to the forwarder becomes an EventBridge one-shot — three systems that must be simultaneously right and all silent from inside the agent when they are not. The FIRE is only weakly checked, via a self-deleting alarm's disappearance |

## What a probe deploys

`installSpec(agentDir)` answers it, and the answer is always the same one: **the tarball of this
checkout**, packed once per run by the `globalSetup` in `vitest.live.config.ts`.

It used to be a version string, which npm resolves from the **registry**. The container then ran the
last published release while the CLI, the generated template and the forwarder all came from the
working tree — a pair that exists nowhere, and a probe that cannot fail on the code under review. A
`POST /run` branch shipped a forwarder speaking a newer envelope than the container it deployed,
and the only symptom was "EventBridge never delivered".

`FASTAGENT_LIVE_VERSION` no longer reaches a deploy probe, in CI either. Three of the four artifacts
one exercises — the CLI, the generated template, the forwarder — come from the checkout
unconditionally, so pinning the fourth produces a mixture rather than "the release under test".
**Verifying a release means checking out its tag.** The pin still decides `registry.live.test.ts`,
whose subject IS the registry.

The generated Dockerfile carries `*.tgz` into the install layer so the `file:` dependency survives the
build (`deploy/container.ts`).

## If a deploy probe seems to hang

The `--push` to ECR is the part that stalls, and it stalls **silently at zero CPU** — the VM idles, the
build steps are all `CACHED` on a manual re-run, and `docker buildx` just sits there. One measurement,
same image, same minute: **420s and unfinished direct, 48.8s through a proxy.**

`~/.docker/config.json`'s `proxies.default` does NOT fix it. That injects build-time env into containers;
the push is the **daemon's** registry client, so the proxy has to be in the daemon's environment
(with colima: `/etc/systemd/system/docker.service.d/http-proxy.conf`, then
`systemctl daemon-reload && systemctl restart docker`). `docker info | grep -i "HTTP Proxy"` confirms it.

Also: run a probe under `nohup` from a file, not inline in a shell that something else can time out.
A killed process never reaches `afterAll`, and the teardown is the only thing that removes the stack,
the ECR repo, the S3 bucket and the forwarder's log group. Two orphaned deployments came from exactly
that, and `aws s3 ls | grep fa-` is how you find the ones still holding a bill.
