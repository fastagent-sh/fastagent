# fastagent

WSGI for agent serving: turn an existing agent definition (`AGENTS.md` + `skills/`) into a production service without rewriting it. Engine-neutral, model-neutral, and cloud-neutral.

This repository is a from-scratch implementation of the locked [Agent Handler SPEC v0.1](docs/SPEC.md). It does not carry compatibility baggage from older experiments.

## Documentation

| Document | Purpose |
|---|---|
| [SPEC.md](docs/SPEC.md) | **Agent Handler protocol**: the engine-neutral contract layer. `status: locked` v0.1 |
| [core-design.md](docs/core-design.md) | The pi-based reference implementation of the SPEC, plus the N × M × K layering model |
| [session.md](docs/session.md) | Draft session-admin model: event-sourced conversation DAG, fork, and navigation. `status: design` |
| [fastagent.md](docs/fastagent.md) | Product index and positioning overview |
| [positioning.md](docs/positioning.md) · [comparisons.md](docs/comparisons.md) | Strategic positioning and competitive analysis |

## Build order

1. **core** (`core/`) — implement the SPEC in code: the reference `invoke` implementation fans pi's two-port harness into one event stream.
2. **Adapters on both sides** — N-side triggers/channels and K-side hosts/target adapters.
