---
title: Immutable agent artifacts and configurable instances
description: "The artifact/instance target: a compiled definition package, environment requirements, separately selected context, private work/state and add-only capabilities."
type: design-doc
status: architecture decided; activation and public contracts pending; not implemented
---

# Immutable agent artifacts and configurable instances

**Tracking: [#900](https://github.com/fastagent-sh/fastagent/issues/900); design PR
[#901](https://github.com/fastagent-sh/fastagent/pull/901).** The ownership model, layout principles and configuration
roles below are decided. Exact public types, context schema, dependency resolution and capability activation require
review/proof before implementation. FastAgent 0.29.0 still opens writable author directories; this document does not
advertise a working artifact loader, separate environment/context files or live runtime additions.

## 1. Product and ownership model

Build one agent program, install it in an embedding application, or derive a deployment from the same artifact. Each
instance supplies its own working context, credentials, writable files and lifetime. A receiver must not need the
author's checkout or private machine configuration. Kage is one consumer, not the product or acceptance boundary.

```text
Author source -> build -> immutable npm definition package
                                  |
                                  + instance A + context A + environment/credentials A
                                  + instance B + context B + environment/credentials B
```

| Concept | Owns | Changes when |
|---|---|---|
| Source | The author's code, instructions, skills and requirements | The author edits it and builds |
| Artifact | One built program version, with relocatable resources | A different package version is selected |
| Environment requirements | Commands/runtimes and declared variable names the program needs | A new program version declares different requirements |
| Context configuration | Which files/directories/repositories or other supported data sources an instance accesses | The user/host explicitly configures the instance |
| Instance | Bindings, credentials, work, clones, accepted additions, sessions and caller state | That instance operates or is reconfigured |
| Model context | The instructions, capabilities and selected information a request presents to the model | Constructed from the effective instance/request state |

A remote repository is not automatically part of a program definition. The same reviewer can work on a local checkout
in one instance and a different remote repository in another without rebuilding its package. Small fixed reference
material belongs in packaged assets or a skill; mutable external reference material belongs in explicitly selected
context. Acquiring data is not permission to send every file or credential to the model.

## 2. Invariants

- **Route B:** a compiled npm package exports a definition/recipe, not a live Agent singleton.
- The base package is immutable: original `SYSTEM.md`, `AGENTS.md`, skills, prompts, tools, configuration, environment
  requirements and MCP declarations are not modified by a running instance.
- Instances can add skills, prompts, MCP integrations and tools. Additions do not shadow, replace or merge over
  packaged/protected capabilities. No editable base copy or last-writer-wins overlay is needed.
- Named prompt templates and supplemental instructions are different capabilities. Adding instructions changes
  behavior even without changing `SYSTEM.md`; “add-only” is not a claim that behavior or authority cannot change.
- Updating a package must not erase instance context configuration, additions, working files, credentials or user data.
  New name/dependency conflicts require a visible, explicit resolution, never silent deletion or replacement.
- One harness, instance-owned clients, explicit shared grants, storage leases, actionable errors and unsafe replay
  remain. [Agent API](../SPEC.md) sessions/messages semantics are unchanged by this design.
- Directory ownership is not a sandbox. Normal runtime writes must never target the installed package, and acceptance
  must use an actually read-only package filesystem. Preventing hostile shell/native code from altering files the host
  user can write requires host permissions, read-only mounts or execution isolation.

Build/release/run separation is the baseline. Runtime additions never mutate the base release. New executable tools
need a build/version identity and an activation boundary of their own. Loading arbitrary JS into a live process is not
strict [Twelve-Factor](https://12factor.net/build-release-run) simply because its files sit in another directory.
Whether activation reloads an instance/worker or changes a live registry must be proved and decided explicitly.

## 3. Source layout and complete output package

The confirmed layout principles are:

1. Root declarations and `src/` code; no second author-maintained manifest of modules/capabilities.
2. Single-file entries for small capabilities; directory entries for larger ones. Keep resources near their owner.
3. `dist/` is a complete, self-contained publishable package. Runtime does not consult the author directory.
4. Instance configuration/data, credentials, clones and additions do not enter that package.
5. File placement does not decide configuration ownership; environment and context have the roles in §4.

Recommended source layout; optional directories/files exist only when used:

```text
agent-source/
  package.json
  fastagent.config.ts
  SYSTEM.md  AGENTS.md
  skills/  prompts/
  src/
    tools/  extensions/  channels/  schedules/
    lib/                     optional shared helpers
  assets/                    optional definition-wide resources
  environment.json           optional program runtime requirements
  .mcp.json                  optional base MCP declarations
  test/  README.md
```

A local development instance may select a `context.json` stored nearby, but it is instance input, not a required part
of the source or artifact. Examples must be distinguished from an active instance's private configuration.

A capability can be `src/tools/search.ts` or `src/tools/search/index.ts`, not both under one identity. Its directory may
hold helpers, JSON, templates and tests; only its entry is registered. Do not recursively treat every source file as a
capability. Per-tool data stays with that tool; per-skill scripts/references/assets stay with the skill; `assets/` is
for shared program resources. There is no mandatory `src/data/` directory or requirement to create all four kinds.

```text
dist/
  package.json               generated publication metadata/exports
  index.js  index.d.ts        generated definition entry
  fastagent.config.js
  SYSTEM.md  AGENTS.md
  skills/  prompts/
  src/                       compiled JS plus its required file resources
  assets/
  environment.json
  .mcp.json
  LICENSE                    when applicable
```

This is one output resource root, not code in one root and data recovered from the parent checkout. Preserve relative
asset relationships. [Agent Skills](https://agentskills.io/specification) allows scripts/references/assets relative to
the skill root. [Node refuses TS type stripping under `node_modules`](https://nodejs.org/api/typescript.html), so the
runtime entry/module graph must be executable JS. Compiling module imports does not authorize guessing and rewriting
paths inside arbitrary strings, skill scripts or MCP arguments. Validate/document those paths and the required runners.

Build into clean staging, include the required code/assets, and inspect the actual tarball. npm's `files`/ignore rules
are not secrets protection. Exclude tests, instance files, values, clones, logs and build-machine paths. No build step
requires actual instance credentials, starts MCP/Agent clients or embeds the builder's environment values. This does
not prove arbitrary authored files contain no hard-coded secrets or make untrusted build scripts safe.

## 4. Configuration: program requirements and instance context

### `environment.json`: what the program needs

This optional data declaration travels with the artifact. It describes command/runtime requirements and names of
variables used by scripts/commands. Code dependencies remain in `package.json`; module-local secret needs remain
beside their consumers. Do not duplicate the language package manager or include actual environment/credential values.

Provisioning is separate from declaration. A build/deployment or an explicitly configured host mechanism can satisfy
requirements; startup resolves/checks the supplied environment and reports what is missing. Do not promise that installing
an npm definition also installs arbitrary OS dependencies, silently changes the host globally or provides a cross-platform
package resolver. The final schema, installation policy and placement of existing Debian `aptPackages` hints remain
review items. Process-wide environment mutation cannot select an instance inside a multi-agent host.

### `context.json`: what this instance works with

This optional, separately selected configuration belongs to the user/instance. It is not shipped in the definition
package and is not a combined environment/LLM-context manifest. An API-provided value and the CLI's file adapter must
use the same resolution rules; embedding hosts need not maintain a file if they already own configuration storage.

A source's location does not decide its owner: both a local path and a remote repository may be selected for one
instance. The model receives a deliberate view of names, locations and descriptions, not all source data or secrets.
The user's configured source stays distinct from the runtime's resolved locations, fetched revision and diagnostics.

| Source | Possible acquisition | Contract still required |
|---|---|---|
| Local file/directory | Bind an existing path; a container may mount it | Availability, relative-path base, ownership and enforced access |
| Repository | Bind a checkout or clone into instance storage | Ref/update policy, authentication and protection of uncommitted work |
| Cloud storage | Mount, download or synchronize through a supported adapter | Write-back, refresh, offline behavior and consistency; do not imply all are equivalent |
| Cloud documents | Export/synchronize as files | Sync/format semantics; direct service operations are otherwise MCP/API tools |

“Mount context” is a user-facing concept, not a claim that every source uses an OS mount. Initial implementation must
name the supported source matrix. Current directory/GitHub support is evidence for that subset, not proof of standalone
file bindings or cloud-storage adapters. Do not silently skip an unsupported or required unavailable source.

Replacing an instance's context selection does not replace program capabilities. Optional author-declared input names
or requirements may be useful, but their schema and whether they belong in the first slice are not decided. Avoid a
new generic resource framework to support a hypothetical requirement. Packaged reference assets are not instance context.

Context configurations may be reused deliberately, but shared configuration is not private copies of the underlying
data or concurrent-writer isolation. Secrets remain outside it as values; use credential references. The package and
instance retain distinct MCP declaration/addition ownership; `.mcp.json` does not become a `connectors` field here.

## 5. Instance root, cwd and resource paths

The host selects a durable instance root and can explicitly select an external tool cwd. The default cwd is the
instance's own `work/`, not the installed program. An external cwd is user-owned and cannot be deleted/replaced by a
package upgrade or instance cleanup. Resolve this input once rather than giving every subsystem a different fallback.

```text
instance/
  context.json               when using the file adapter
  work/
  content/                   instance-acquired data, not all user-owned sources
  additions/                 accepted extra capabilities; not arbitrary work files
  .state/
  .secrets/                  or host-supplied credential stores
```

This is the intended ownership map, not a promise that all hosts must store credentials in that tree or retain disks
forever. AgentCore's storage-reset limits stay explicit. Final public option names are not selected by the directory
names; prefer one instance root over a flag per internal subdirectory.

| Path use | Base |
|---|---|
| Module-owned packaged asset | Module-relative URL, never builder path/process cwd |
| Skill reference | That packaged/added skill's root |
| Relative coding-tool file/command path | Resolved instance cwd |
| Context file's relative source | A documented configuration-file base; finalize together with API-relative inputs |
| MCP executable/resource path | Its declaration's documented base; do not relocate child cwd or guess args because tool cwd changed |
| Working data passed to MCP | Explicit instance bindings/variables |

Never call `process.chdir()` or mutate `process.env` to switch an instance. Effective paths/values are shared knowledge
for execution, inspection and host reports. Acquire the instance lease before mutating owned runtime state, additions or
acquired content. Reuse the existing storage and atomic-write machinery rather than a parallel state system.

## 6. Additions, activation and upgrades

An ordinary file written into `work/` does not automatically become an enabled tool. Candidates must be explicitly
staged, validated and accepted. Accepted capabilities have their own identity/provenance and durable record, separate
from package bytes and secrets. Names cannot shadow base, built-in/protected or already accepted capabilities.

| Capability | Reuse | Required proof |
|---|---|---|
| Skill | Skill discovery and root-relative resources | Complete-directory validation, collisions, acceptance/visibility |
| Prompt template | Named command expansion | Separate supplemental instructions; explicit scope and collision rules |
| MCP server | Strict parsing, scoped clients, explicit grants | Auth policy and acquire/discover/validate before exposure; failure cleanup |
| Script/command tool | Execution environment, schema and unsafe replay | Bounded adapter, dependency ownership, cancellation and validation |
| Native JS tool | Application-owned harness registry | Instance-local loading, invocation snapshots, cleanup, restart and compatibility |

pi-durable 1.4.0 registry snapshots are useful, but `install` can replace an extension of the same name. That is not an
add-only policy or proof of a safe FastAgent hot-loader. Existing MCP discovery is once per open. Native module imports
can have irreversible side effects; do not claim arbitrary in-process imports can be rolled back or safely unloaded.

Before implementation, settle:

1. **Activation:** durable candidate/accepted/effective ordering, atomic visibility, concurrency and the request/reopen
   boundary. Do not change an in-flight invocation's tool implementation or break explicit session tool allowlists.
   Admission, `info`, prompt commands and replay must agree on the effective revision.
2. **Failure/recovery:** diagnose failed validation/start/save, partial acquisition and unavailable accepted capabilities.
   Decide whether reopen blocks or exposes a clearly unavailable capability; never silently omit one or replay a remote
   operation whose outcome is uncertain. Accepted bytes cannot silently change under the same identity.
3. **Upgrade/management:** retain additions and work; detect name/runtime/dependency conflicts before selecting the new
   package, preserve data and fail visibly. Select a compatible version or an explicit host resolution, never quietly
   overwrite a base capability. Define whether/when an addition can be disabled or removed without changing historical
   messages; “only add to the base” does not eliminate security/operational revocation needs.

A tool/addition cannot silently initiate browser consent, choose another account, broaden scopes or modify global OS/npm
dependencies. Existing credential/grant APIs retain their ownership and exclusive refresh rules. Dynamic channels,
schedules, general plugin marketplaces and sandbox implementation are not implied by this first refactor.

## 7. Implementation review and experiment evidence

The current seams to change, not reasons to rewrite the product:

| Current implementation | Required separation |
|---|---|
| `prepareDefinition` writes TS registry/secrets metadata on open | Build/source preparation versus loading an already-built definition |
| Config loading expects `fastagent.config.ts` | Explicit compiled-definition entry, not filename fallback guessing |
| `agentDir` supplies cwd, values, local bindings and clone paths | Definition resources versus resolved instance input |
| Runtime prompt describes an editable definition in cwd | Immutable base, work/context and accepted additions |
| Deploy copies/replaces the author directory | One selected artifact plus preserved instance data |
| Content/environment share `context.json` and local/remote determines placement | Environment requirements versus independently selected instance context |

Disposable probes on 0.29.0 showed source-tarball execution after extraction on Node 26.11.1, Bun 1.4.4 and native Linux
ARM64/Node 24.15.0, including tools/data, skills/prompts, official Filesystem MCP 2.1.0 and Agent HTTP calls. Direct Node
execution inside `node_modules` failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; a compiled entry imported,
but the current opener generated TS again and ignored `.js` config outside that tree (`missing_model`). Read-only
startup failed on `.fastagent` writes despite external state. npm packing included a nested skill `.env` and omitted
`package-lock.json`; shrinkwrap was included when selected, not proof of all installation locking behavior.

Two opens of the same definition with different `stateDir` values shared cwd, relative output files, local content
bindings and default values; process cwd/environment remained unchanged. These are boundary experiments, not a supported
artifact format or live-addition acceptance. Temporary files/images were deleted. [#896](https://github.com/fastagent-sh/fastagent/issues/896)
is an independent provider-resource cleanup issue; path changes do not fix it.

## 8. Remaining decisions and delivery sequence

The architecture is settled; these contracts still block claiming a complete implementation design:

- exported definition/public instance types, dependency compatibility and reproducible deployment installation;
- exact environment/context schemas, context-path bases and the first supported source/provisioning matrix;
- activation, required-capability failure/recovery, revocation and upgrade conflict behavior in §6.

Recommended sequence:

1. Prove a compiled `dist/` package installed under `node_modules`, with read-only resources and an explicit instance
   root/cwd, on Node/Bun. Exercise single-file/directory entries, adjacent assets and independent instances.
2. Implement environment/context ownership and one resolver; validate host/CLI inputs without writing the package.
3. Derive a representative deployment from the same artifact. Preserve leases, state/secrets, external data and current
   Agent API conformance. There is no backward-compatibility/migration layer to carry obsolete ownership rules.
4. Prove text additions, MCP acquisition and script tools at a documented safe boundary; native tools follow only when
   their build/lifecycle can be demonstrated. Test crashes, cancellation, failed persistence and unchanged base hashes.
5. Review any necessary public SPEC changes separately. Completing design or passing a source-only probe does not close
   the implementation issue or imply every source type/cloud/runtime has been accepted.

Out of scope: context packages, Registry/MCPB, marketplace/discovery, orchestration/scale-out and safe untrusted-package
execution. Success is one installable definition, correctly owned independent instances and observable context/addition
lifecycle, not more configuration fields or an assumed hot-loading feature set.
