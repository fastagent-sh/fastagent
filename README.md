# fastagent

WSGI for agent serving: turn an existing agent definition (`AGENTS.md` + `skills/`) into a production service without rewriting it. Engine-neutral, model-neutral, and cloud-neutral.

This repository is a from-scratch implementation of the locked [Agent Handler SPEC v0.1](docs/SPEC.md). It does not carry compatibility baggage from older experiments.

## Install

`@kid7st/fastagent` is published to **GitHub Packages** (private), so installs authenticate with a GitHub token that has `read:packages`. Put the scope registry and token in your **user** npm config (`~/.npmrc`) so it applies to both a global CLI install and a project dependency, from any directory:

```
@kid7st:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

(A per-project `.npmrc` is only read when you run npm from within that project, and a global `npm i -g` is usually run from elsewhere — so the user config is the reliable place. If you commit a project `.npmrc`, keep only the registry line there and supply the token via env / `~/.npmrc`; never commit the token.)

Then install (requires Node ≥ 26):

```bash
npm i -g @kid7st/fastagent   # the `fastagent` CLI on PATH
npm i @kid7st/fastagent      # the library (defineConfig, the Agent contract, …) for code-tool agents
```

The package ships compiled JavaScript + type declarations (`dist/`); the repository itself runs the TypeScript sources directly under Node 26.

## Documentation

| Document | Purpose |
|---|---|
| [SPEC.md](docs/SPEC.md) | **Agent Handler protocol**: the engine-neutral contract layer. `status: locked` v0.1 |
| [core-design.md](docs/core-design.md) | The pi-based reference implementation of the SPEC, plus the N × M × K layering model |
| [session.md](docs/session.md) | Draft session-admin model: event-sourced conversation DAG, fork, and navigation. `status: design` |
| [fastagent.md](docs/fastagent.md) | Product index and positioning overview |
| [positioning.md](docs/positioning.md) · [comparisons.md](docs/comparisons.md) | Strategic positioning and competitive analysis |

## API stability

This repository is pre-1.0. The stable design center is the Agent Handler contract in [SPEC.md](docs/SPEC.md). The root export (`@kid7st/fastagent`) is deliberately scoped to the supported public surface; pi-coupled internals are not exported and may change freely while `build`, `start`, and the first target adapters land.

Public surface tiers:

| Tier | Examples | Stability |
|---|---|---|
| Contract | `Agent`, `AgentEvent`, `collect`, `createInvokeHandler` | Intended to remain stable within SPEC v0.1 |
| Pi assembly ladder | `createPiAgentFromWorkspace`, `createPiAgentFromDefinition`, `createPiAgent` | Usable now, may tighten before 1.0 |
| Injection ports | `PiSessionStore`, `inMemorySessionStore`/`jsonlSessionStore`, `AuthResolver`, `Lease`, `piDefaultTools`/`piReadOnlyTools` | Public because the ladder options reference them |
| Not exported | L0 `createPiAgentFromHarness`, `piHarnessFactory`, prompt/config assembly internals | Internal modules only; they expose pi's engine shape and are not a compatibility promise |

## Build order

1. **core** (`core/`) — implement the SPEC in code: the reference `invoke` implementation fans pi's two-port harness into one event stream.
2. **Adapters on both sides** — N-side triggers/channels and K-side hosts/target adapters.

## License

[MIT](LICENSE).
