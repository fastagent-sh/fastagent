# Security Policy

## Supported versions

FastAgent is pre-1.0. Security fixes land on the latest published `0.x` release only. Pin a version and upgrade forward to receive fixes.

| Version | Supported |
|---|---|
| latest `0.x` | ✅ |
| older `0.x` | ❌ |

## Reporting a vulnerability

Do not open a public issue for a security report.

Use GitHub's private vulnerability reporting: open the repository's **Security → Report a vulnerability** form (`https://github.com/kid7st/fastagent/security/advisories/new`).

Please include:

- the affected version (`fastagent --version`) and environment,
- a minimal reproduction or proof of concept,
- the impact you observed,
- any suggested remediation.

We aim to acknowledge a report within 5 business days and to provide a remediation timeline after triage. Please give us a reasonable window to ship a fix before any public disclosure.

## Scope

In scope:

- the `@kid7st/fastagent` package (CLI, library API, reference implementation),
- the first-party channel adapters (`/github`, `/telegram`),
- credential handling in `~/.fastagent/auth.json` and the OAuth/env auth resolution path.

Out of scope:

- vulnerabilities in your own agent definition (`AGENTS.md`, skills, tools you author),
- third-party model providers, hosts, and channels,
- issues that require a compromised local machine or leaked secrets you control.

## Handling secrets

FastAgent treats credentials and environment as deployment config, never as part of the agent definition:

- keep `.env`, provider keys, and `~/.fastagent/auth.json` out of version control,
- the scaffolded `.gitignore` excludes `.env`; `fastagent init` warns when a pre-existing `.gitignore` does not,
- webhook channels require a verification secret (`GITHUB_WEBHOOK_SECRET`, `TELEGRAM_SECRET_TOKEN`) and fail at startup when it is missing, rather than accepting forged deliveries.

If you find a case where a secret can leak into the agent definition, logs, or the deployable artifact, report it through the process above.
