# Live probes

Every file here exists to check an **assumption about a system we do not own**. None of them re-runs
logic the offline suite already covers — that is what the offline suite is for. If a probe would
still pass with the third party replaced by a fake, it does not belong here.

Excluded from `npm test`. `npm run test:live` (`vitest.live.config.ts`) opts in, and a missing
credential **fails** rather than skips — you asked for them. Credentials arrive the product's way
(`FASTAGENT_AUTH_PATH` → an `auth.json`), which is what lets an OAuth-only provider be the model.

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
| `schedule` | a cron on disk firing a real turn into the audit log |
| `telegram`, `feishu` | Telegram VERIFYING a webhook URL it was handed; Feishu CALLING one with a challenge. Registration only — delivery needs a human to type |
| `slack` | Slack's Bot API answering our pipeline. OUTBOUND only: the inbound half needs a 12h App Configuration Token, which no nightly can hold |
| `fly` | `flyctl` still prints what the Fly driver reads (read-only) |
| `fly-deploy` | a REAL Fly app provisioned then destroyed — how #425 was found: a deploy whose every step succeeded, serving on a URL that had no IP |
| `railway` | the `railway` CLI still prints what its driver reads (read-only). Also the file that dates the "Verified against CLI 5.15.0" claims in `run.ts` |
| `railway-deploy` | a REAL Railway project provisioned and destroyed — the only way to observe `railway domain`, which MINTS one when absent |
| `agentcore` | CloudFormation ACCEPTING the YAML this repo emits by hand, forwarder and schedule branches included (read-only, free, and the only check that the template parses) |
| `agentcore-deploy` | a REAL stack + ECR repo + S3 bucket provisioned and destroyed. No public URL exists, so it proves the deployment works through `InvokeAgentRuntime`. Teardown is THREE places because the repo and runtime-created wake alarms live outside the stack on purpose, and it is ONE shared function in `env.ts` because a second copy of cleanup code drifts where nobody looks |
| `agentcore-wake` | an agent SCHEDULING ITSELF on a host with no resident process: the wake tool's write becomes a POST to the forwarder becomes an EventBridge one-shot — three systems that must be simultaneously right and all silent from inside the agent when they are not. The FIRE is only weakly checked, via a self-deleting alarm's disappearance |
