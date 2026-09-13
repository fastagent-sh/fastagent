---
title: Distribution and provenance
description: "Why a workspace has no manifest: what is derivable from the filesystem, what must be recorded, and why a record belongs beside the thing it describes rather than in the directory around it."
status: current
---

# Distribution and provenance

**A workspace has no marker file, and will not get one until one of the triggers in §6 fires.** What such a
file would hold is either derivable from the filesystem or belongs to an agent rather than to the directory
around it. The one genuine gap is **provenance** — where a vendored skill or agent came from — and that
record travels *with* the thing it describes.

## 1. The test a file has to pass

A file earns its existence by carrying information that cannot be derived from what is already on disk.
Applied to the four things a `fastagent.json` at the workspace root would plausibly hold:

| Candidate fact | Derivable? |
|---|---|
| "this directory is a workspace" | **Yes.** A workspace is not a property, it is a *role*: the directory you pointed fastagent at this time. The same directory is a workspace in one invocation and an agent directory in another (a deployed container is shipped the agent alone), and no file can be right in both |
| "these are the agents here" | **Yes.** `agentsAt()` scans one level; `fastagent.config.ts` is the marker. A second list is a second truth, and it drifts |
| "this one answers by default" | **Already conventional.** The agent named `fastagent` wins; `FASTAGENT_AGENT` overrides |
| **"this skill/agent came from X at commit Y"** | **No.** `vendorSkill` writes the files and keeps nothing about where they came from |

Only the last row is real, and it is not about the workspace.

## 2. Provenance belongs to the definition, not the workspace

A vendored skill lands in `<agent>/skills/<name>/`. It is part of **that agent's definition**, and the
definition is what ships: `deploy` carries the agent directory into the image and leaves the workspace
behind. A provenance record kept at the workspace root would not travel with the thing it describes, and the
definition would stop being self-contained — which is the property the whole deployment model rests on.

The rule generalizes, and it is the same one the secrets-file work arrived at the expensive way: **a record
lives beside what it describes, not in a larger container that happens to hold it.** So a future
`fastagent add agent <ref>` records provenance inside the agent directory it created, not in a list outside
it.

## 3. Three shapes in the wild, and which one we are

**Workspace manifests** (`pnpm-workspace.yaml`, npm's `workspaces` field, Cargo workspaces) exist for two
reasons we do not share. Members cannot be found by scanning — `packages/*` is a glob whose matches are not
all members, so the set must be declared. And packages are **derived artifacts**: `node_modules` is deletable
and rebuildable, so a manifest is the only way back. Our agents declare themselves with a config file, and
they are *source*, not a rebuildable artifact.

**Agent-asset package managers** — Microsoft's [APM](https://microsoft.github.io/apm/reference/lockfile-spec/)
(`apm.yml` + `apm.lock.yaml`), agentpack (`agentpack.toml` + lock), harness-ai-kit, AgentNode — converged on
manifest + lockfile within a year of each other. APM states the purpose plainly: the lockfile is the source of
truth for *reproducible installs and drift detection*, and you commit it. That machinery pays for itself only
when the installed thing is a dependency you do not edit.

**Claude Code plugins** take a third route: installs are recorded in `settings.json` (`enabledPlugins`) while
the sources are cached under `~/.claude/plugins/cache`, outside the project. The `marketplace.json` in that
ecosystem is the **publisher's** catalog, not a marker in the consumer's workspace — a distinction worth
keeping straight when reading it as a precedent.

## 4. The fork that actually decides this

Not "does a workspace need a file" but **is an installed agent vendored source or a dependency**:

| | Vendored source (what we are) | Dependency |
|---|---|---|
| After install | Yours. Edit it. Commit it | Untouched, gitignored, rebuildable |
| Needs a lockfile | No — the code itself is in git | Yes |
| Provenance answers | "has upstream moved?" | "rebuild this exactly" |

`add skill` is explicitly the left column today: the docs say the scaffold is written once and is yours after
that. The left column needs one line of provenance next to the vendored directory. It does not need a
manifest, a lockfile, or a workspace file.

## 5. What is missing right now

`vendorSkill` (`src/scaffold/vendor-skill.ts`) resolves a giget ref, writes `skills/<name>/`, and records
nothing. After `fastagent add skill <owner>/<repo>/<path>` there is no way to answer where it came from,
which commit it was, or whether upstream has changed — and `--update` overwrites blind. Closing that is a
per-skill file, not a workspace one.

## 6. When to revisit

Two triggers, either of which makes a workspace-level file the right answer rather than a premature one:

1. **Installed agents stop being committed.** If they become gitignored and rebuildable, reproducibility
   requires a manifest + lockfile, and §3's B-shape becomes ours.
2. **One process serves several agents.** Shared routing across agents needs something to describe the set.
   Note that this is *orchestration*, which [configuration.md](configuration.md) §1 places outside the
   convention boundary — so it is a product decision before it is a file-format one.

Until then, adding the file would be building a mechanism for a need nothing has demonstrated.

## 7. Not doing

| Rejected | Why |
|---|---|
| `fastagent.json` / `fastagent.yaml` at the workspace root | §1: three of its four facts are derivable or already conventional |
| A declared list of the workspace's agents | A second truth beside the filesystem, free to drift from it |
| A lockfile for skills or agents | §4: vendored source is already pinned by being committed |
| A registry or marketplace of our own | Nothing has asked for discovery; `giget` refs already reach GitHub, and a catalog is a publisher-side concern (§3) |
