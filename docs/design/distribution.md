---
title: Distribution and provenance
description: "Why there is no manifest of agents: what is derivable from the filesystem, what must be recorded, and why a record belongs beside the thing it describes rather than in a directory around it."
status: current
---

# Distribution and provenance

**There is no manifest of agents, and there will not be one until one of the triggers in §6 fires.** What such a
file would hold is either derivable from the filesystem or belongs to an agent rather than to a directory
around it. The one genuine gap is **provenance** — where a vendored skill or agent came from — and that
record travels *with* the thing it describes.

## 1. The test a file has to pass

A file earns its existence by carrying information that cannot be derived from what is already on disk.
Applied to the four things a `fastagent.json` in a directory of agents would plausibly hold:

| Candidate fact | Derivable? |
|---|---|
| "this directory is an agent" | **Yes.** `fastagent.config.ts` is the marker |
| "these are the agents here" | **Not needed.** A command names its agent by path and nothing lists them. A second list is a second truth, and it drifts |
| "this one answers by default" | **Not needed.** A path selects exactly one agent; there is no default to choose |
| **"this skill/agent came from X at commit Y"** | **No.** `vendorSkill` writes the files and keeps nothing about where they came from |

Only the last row is real, and it is not about a directory of agents.

## 2. Provenance belongs to the definition

A vendored skill lands in `<agent>/skills/<name>/`. It is part of **that agent's definition**, and the definition
is what a deploy ships: the agent directory is the build context, and every release replaces the deployed copy.
Agents are also run and moved independently of wherever they were created. A provenance record anywhere outside
the agent directory would therefore stop following the skill after a deploy or a move.

The rule generalizes, and it is the same one the secrets-file work arrived at the expensive way: **a record
lives beside what it describes, not in a larger container that happens to hold it.** So a future
`fastagent add agent <ref>` records provenance inside the agent directory it created, not in a list outside
it.

## 3. Three shapes in the wild, and which one we are

**Workspace manifests** (`pnpm-workspace.yaml`, npm's `workspaces` field, Cargo workspaces) declare which
source packages participate so their package manager can resolve local dependencies and run cross-package
install, build, test, or publish operations. Package members are source code; `node_modules` contains the
rebuildable installed dependencies. FastAgent has no cross-agent dependency graph or package operation across
agents today. It only needs to open the agent a command names, which declares itself with `fastagent.config.ts`.

**Agent-asset package managers** — Microsoft's [APM](https://microsoft.github.io/apm/reference/lockfile-spec/)
(`apm.yml` + `apm.lock.yaml`), agentpack (`agentpack.toml` + lock), harness-ai-kit, AgentNode — converged on
manifest + lockfile within a year of each other. APM states the purpose plainly: the lockfile is the source of
truth for *reproducible installs and drift detection*, and you commit it. That machinery pays for itself only
when the installed thing is a dependency you do not edit.

**Claude Code plugins** take a third route: installs are recorded in `settings.json` (`enabledPlugins`) while
the sources are cached under `~/.claude/plugins/cache`, outside the project. The `marketplace.json` in that
ecosystem is the **publisher's** catalog, not a marker in the consumer's project — a distinction worth
keeping straight when reading it as a precedent.

## 4. The fork that actually decides this

Not "does a directory of agents need a file" but **is an installed agent vendored source or a dependency**:

| | Vendored source (what we are) | Dependency |
|---|---|---|
| After install | Yours. Edit it. Commit it | Untouched, gitignored, rebuildable |
| Needs a lockfile | No — the code itself is in git | Yes |
| Provenance answers | "has upstream moved?" | "rebuild this exactly" |

`add skill` is explicitly the left column today: the docs say the scaffold is written once and is yours after
that. The left column needs one line of provenance next to the vendored directory. It does not need a
manifest, a lockfile, or a file listing agents.

## 5. What is missing right now

`vendorSkill` (`src/scaffold/vendor-skill.ts`) resolves a giget ref, writes `skills/<name>/`, and records
nothing. After `fastagent add skill <owner>/<repo>/<path>` there is no way to answer where it came from,
which commit it was, or whether upstream has changed — and `--update` overwrites blind. Closing that is a
per-skill file, not one for a directory of agents.

## 6. When to revisit

Two triggers, either of which makes a file describing several agents the right answer rather than a premature one:

1. **Installed agents stop being committed.** If they become gitignored and rebuildable, reproducibility
   requires a manifest + lockfile, and §3's B-shape becomes ours.
2. **One process serves several agents.** Shared routing across agents needs something to describe the set.
   Note that this is *orchestration*, which [configuration.md](configuration.md) §1 places outside the
   convention boundary — so it is a product decision before it is a file-format one.

Until then, adding the file would be building a mechanism for a need nothing has demonstrated.

## 7. Not doing

| Rejected | Why |
|---|---|
| `fastagent.json` / `fastagent.yaml` in a directory of agents | §1: three of its four facts are derivable or not needed |
| A declared list of agents | A second truth beside the filesystem, free to drift from it |
| A lockfile for skills or agents | §4: vendored source is already pinned by being committed |
| A registry or marketplace of our own | Nothing has asked for discovery; `giget` refs already reach GitHub, and a catalog is a publisher-side concern (§3) |
