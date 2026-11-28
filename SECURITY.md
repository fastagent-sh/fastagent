# Security Policy

## Supported versions

FastAgent is pre-1.0. Security fixes land on the latest published `0.x` release only. Pin a version and upgrade forward to receive fixes.

| Version | Supported |
| --- | --- |
| latest `0.x` | ✅ |
| older `0.x` | ❌ |

## Reporting a vulnerability

Do not open a public issue for a security report.

Use GitHub's private vulnerability reporting: open the repository's **Security → Report a vulnerability** form (`https://github.com/fastagent-sh/fastagent/security/advisories/new`).

Please include:

- the affected package and version (`fastagent --version`) and environment,
- a minimal reproduction or proof of concept,
- the impact you observed,
- any suggested remediation.

We aim to acknowledge a report within 5 business days and provide a remediation timeline after triage. Please allow a reasonable window to ship a fix before any public disclosure.

## Scope

In scope:

- `@fastagent-sh/fastagent`, `@fastagent-sh/client`, `@fastagent-sh/client-agentcore`, `@fastagent-sh/agentcore`, and `@fastagent-sh/harness-dsh`,
- credential handling across `<agentDir>/.secrets/auth.json`, `~/.fastagent/.secrets/auth.json`, `<root>/.state/auth.json`, durable instance credentials (`<root>/.state/credentials.sqlite` and PostgreSQL `fastagent_credentials`), saved remote configs (`~/.config/fastagent/remotes.json`), and OAuth/env resolution paths,
- HTTP Agent API authentication (`FASTAGENT_API_KEY`), build-context secret leak checks (`fastagent deploy check`), subprocess environment sanitization, and `@fastagent-sh/harness-dsh` OS sandbox confinement.

Out of scope:

- vulnerabilities in your own agent definition (`SYSTEM.md`, `AGENTS.md`, skills, custom tools, or extensions),
- third-party model providers, MCP servers, and hosting platforms,
- issues requiring an already compromised local machine or leaked secrets you control.

## Handling secrets & isolation

FastAgent keeps credentials and runtime state out of agent definitions and deployable artifacts:

- Keep `.secrets/` (`.env`, `auth.json`), `~/.fastagent/.secrets/auth.json`, `~/.config/fastagent/remotes.json`, `.fastagent/`, `.state/`, and provider keys out of version control and container images.
- `.secrets/` ships its own `.gitignore` (allowing only `.gitignore` and `.env.example`), and the scaffolded root `.gitignore` excludes `.fastagent`, `.state`, `.env`, and `.env.*`. If you pass `--env-file` pointing inside a repository, exclude that path in `.gitignore` and `.dockerignore`.
- Gate CI deployments with `fastagent deploy check` to block builds that would leak local secrets or state.
- On the default `pi-durable` harness, built-in coding tools (`read`, `write`, `edit`, `bash`) act with the OS process's permissions. Use `codingTools: false`, `@fastagent-sh/harness-dsh` OS sandboxing (`workspace` / `read-only`), or isolated containers/microVMs when isolating untrusted inputs or multiple users.

If you find a way a secret can leak into an agent build, trace, log, or deployable image, or a bypass in authentication or sandbox confinement, report it through the process above.
