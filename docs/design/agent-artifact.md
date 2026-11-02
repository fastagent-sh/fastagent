---
title: Immutable agent artifacts and additive instances
description: "The artifact/instance refactor: compiled definitions, resource ownership, instance cwd and additive capabilities; settled boundaries and open design gates."
type: design-doc
status: boundary decided; detailed design under review; not implemented
---

# Immutable agent artifacts and additive instances

**Tracking: [#900](https://github.com/fastagent-sh/fastagent/issues/900).** The product boundary below is decided.
Export shape, directory names, public API spellings and activation mechanics remain under review. FastAgent 0.29.0 still
opens writable author directories; this note does not claim that compiled artifacts or runtime additions are supported.
The consumer [Agent API](../SPEC.md) sessions/messages contract is unchanged by this design PR.

## 1. Problem and product goal

An agent author must be able to build one definition, install it as a dependency in an embedding app, and derive a
host's deployment from the same artifact. A receiver must not need the author's checkout, credentials or local bindings.
The hard part is ownership: a shared installed program, private instance data and an agent's new capabilities must not
write over one another or acquire accidental shared lifetime.

Today `agentDir` owns the authored files, generated registry, prompt/skills, tool cwd, local bindings, default values
and content clones. A different `stateDir` separates database/state paths, not all those other responsibilities.
Wrapping this directory in `npm pack` does not establish the required boundary.

The goal is an immutable program with instance-owned additions. It is not a copy of the program that each instance may
edit. An author may change the source and build a new version; a running instance cannot modify the installed definition.

## 2. Settled boundaries

- **Route B:** compile a normal npm artifact with an importable JavaScript entry and relocatable file resources.
- The packaged definition is immutable, including its `SYSTEM.md`, `AGENTS.md`, skills, prompts, tools, configuration,
  content/environment declarations and MCP declarations. Importing it creates no running Agent or owned connection.
- An instance may **add** skills, prompts, MCP integrations and tools. An addition cannot replace, shadow or merge over
  a packaged/protected capability. No editable base copy, precedence cascade or last-writer-wins overlay is needed.
- Supplemental instructions are not edits to `SYSTEM.md`; named prompt templates are not global system instructions.
  Their scope and visibility must be specified separately before implementation.
- Additions, credentials, instance bindings, working files and content clones are not part of the artifact. Updating
  the package must not erase them. Shared user content and grants remain explicit host choices.
- Preserve one harness, instance-owned clients, storage leases, actionable failure and conservative replay. Do not
  introduce a neutral harness port or a generic Connector. Directory ownership is not filesystem isolation.
- This is an incremental assembly refactor, not a rewrite of sessions/messages, channels or storage.

FastAgent must never direct normal runtime writes or addition activation into the installed package. Test against a real
read-only package filesystem, not just a convention in the prompt. A shell/native plugin with the host user's full
permissions can still alter any writable file that user owns; absolute prevention against hostile code requires a
read-only host mount, restricted identity or execution isolation. Do not claim directory separation alone enforces it.

Build/release/run separation is the deployment baseline. Loading new executable code during a live process is not made
strictly [Twelve-Factor](https://12factor.net/build-release-run) merely by putting it outside the base package. Executable
additions need their own build/version identity and an explicit activation boundary; decide whether activation requires
an instance/worker restart before claiming hot native-tool loading. Text/config and executable additions need separate
proofs. The base release never changes in place in either case.

## 3. What the package exports

The recommended export is a **definition value**: configuration/registrations or factories plus resource locations,
consumed by FastAgent to open an instance. It is not an already-open Agent, a provider login, or an absolute directory
captured from the builder. Functions make it executable JavaScript, not a serializable JSON manifest.

Pure registrations may be shared. Stateful tools/providers and all clients must be instantiated with the instance's
inputs and lifetime. Copying an object cannot duplicate function closures. Arbitrary author imports can execute code;
a definition import is not a safe preview of an untrusted package or a sandbox.

A generated static descriptor is justified only by a concrete build/discovery/inspection requirement. It must be derived,
not a second author-maintained list of tools, capabilities or defaults. Preserve existing authoritative declarations.

Review before choosing the export:

- runtime compatibility and dependency ownership, including duplicate SDK/harness copies;
- code/asset URLs after installation, linking and relocation;
- which validation can run without instance secret values or network clients;
- separation of package identification from the current `fastagent.config.ts` directory marker.

Do not promise one frozen dependency tree in every embedding app. npm omits `package-lock.json` from published packages;
[npm-shrinkwrap.json](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json) can travel, but npm discourages it
for ordinary libraries. Compare a host-resolved dependency contract with a separately locked deployment installation.
No automatic conversion to shrinkwrap or bundled private runtime is decided here.

## 4. Review the definition layout and `context.json`

The existing author layout is a candidate, not a standard or a settled optimum:

```text
agent-source/
  package.json
  fastagent.config.ts
  SYSTEM.md  AGENTS.md
  skills/  prompts/
  src/tools/  src/extensions/  src/channels/  src/schedules/
  src/data/ or assets/             optional author resources, not both by requirement
  context.json
  .mcp.json
```

Keep open-standard files and the no-DSL author workflow. [Agent Skills](https://agentskills.io/specification) permits
scripts, references and assets relative to each skill root. TypeScript source needs a build before Node executes it as
a dependency; [Node refuses type stripping under `node_modules`](https://nodejs.org/api/typescript.html). Preserve relative
asset relationships rather than assuming one bundled JS file can replace the whole definition.

Review the four source discovery directories, helper/resource placement and whether generated output mirrors that tree.
Do not make empty directories mandatory or require an author to restate facts derived from their files. The output
layout must serve package imports and asset URLs; it need not reproduce every authoring filename.

### Is `context.json` the right boundary?

JSON is suitable for declarations edited without executing code. That does not prove that content and environment belong
in one file, that its name communicates its purpose, or that today's local binding location is right for instances.
MCP has its own ecosystem declaration and does not become a `connectors` field as part of this review.

| Candidate | Benefit | Cost to evaluate |
|---|---|---|
| Keep a strict JSON content/environment declaration | Existing CLI/editing flow, harness-neutral data, one parser | Broad name and mixed responsibilities; bindings still need an instance owner |
| Split content and environment declarations | Narrower responsibilities and validation | More files and discovery rules; only worth it if users change/read them independently |
| Move them into typed `fastagent.config.ts` | Fewer author-facing files and TypeScript checking | Executes code to inspect/edit data; harder CLI authoring and build-time secret-free inspection |

Choose by actual author, host and deploy workflows, not by a file-count preference. Answer which facts are portable,
which are instance choices and which are host environment before choosing the carrier. Local paths, grant selections and
secret values do not enter a portable declaration in any candidate. Do not add context-package composition or a new lock
format just to justify the file. No rename, split or schema replacement is decided in this PR.

## 5. Instance root and working directory

The host should select one durable instance root. Resolve the owned paths from it in one place, with an optional explicit
tool cwd when the host wants commands to start in a particular project. An external cwd remains user-owned: a package
upgrade or instance cleanup must not replace/delete it. These are ownership requirements, not final API field names.

| Location | Owns | Lifetime |
|---|---|---|
| Installed artifact/resources | The selected program version | Replaced only by installing/selecting another version |
| Instance configuration | Local content bindings, values and grant selections | Belongs to the instance, not the installed package |
| Instance state/secrets | Database, caller bookkeeping, credential stores | Follows the instance/host's stated storage durability |
| Instance cwd/work files | Default destination for command/file-tool work | Preserved independently of package replacement |
| Instance additions | Accepted extra capabilities and their provenance | Retained on that instance across reopen/package changes |
| Content | User directories or instance clones | Follows its source and explicit binding, never the package |

A possible internal layout is `work/`, `content/`, additions, state, secrets and local configuration under the instance
root. Do not add a public option per subdirectory before a caller needs one. A desktop host may store credentials outside
that tree through the existing store APIs. Host storage limits/reset behavior remain explicit, especially on AgentCore.

Define one path table before implementation:

- module-owned data: module-relative URLs, never a builder path or process cwd;
- skill references: that skill's root, whether packaged or instance-added;
- command/file-tool relative paths: the resolved instance cwd;
- local content bindings: a documented instance-config base, not whichever caller happened to start Node;
- MCP executable/resource paths: a defined declaration base; do not change child cwd or guess which args are paths just
  because coding tools now have a different cwd;
- instance data passed to an MCP server: explicit bindings/variables, not implicit author-machine paths.

Do not call `process.chdir()` or mutate `process.env` to select an instance. The resolved instance input must serve the
run plane, `info`/inspection and deployment reporting alike. Take the relevant instance lease before mutating its owned
runtime files; build caches and user-owned external directories are separate responsibilities.

## 6. Additive capabilities: what is known and what needs proof

Additions are durable, instance-owned inputs to the effective capability set. They do not rewrite the package's files.
Package declarations remain authoritative for the package; accepted additions supply distinct identities, not a second
configuration for the same server/tool. A supplemental instruction changes effective behavior even without editing a
file, so “add-only” is not a guarantee that behavior or permissions stay unchanged.

| Addition | Existing mechanism to reuse | Gate before claiming support |
|---|---|---|
| Skill | File-based discovery, skill-root references and prompt listing | Validate the complete directory; detect collisions; publish only a complete accepted addition |
| Prompt template | Named command expansion | Keep it distinct from supplemental system instructions; specify visibility and collision rules |
| MCP server | Strict declaration parser, scoped clients, tools and explicit grant bindings | Authorize separately, acquire/discover/validate before publishing; close failed acquisitions |
| Script/command tool | Declared schema and execution environment | Prove a bounded adapter, input validation, cancellation, dependency/credential ownership and unsafe replay |
| Native JS tool | pi-durable's application-owned registry | Prove per-instance loading, request snapshots, cleanup, recovery and runtime compatibility; arbitrary module import has side effects that cannot be rolled back |

pi-durable 1.4.0 publishes immutable registry snapshots, but `install` replaces an extension of the same name. It is not an
append-only policy and is not by itself a FastAgent hot-loading API. Existing FastAgent MCP discovery is once per open.
Do not advertise live additions based only on these implementation hooks.

The first design must specify:

1. How a candidate is staged, validated and durably recorded, and exactly when it becomes effective. A browser grant is
   saved through the existing host flow; a runtime addition cannot silently open consent UI or expand scopes.
2. How concurrent additions serialize, which names/identities are reserved, and how clashes with packaged, built-in and
   other added capabilities fail. No shadowing or native registry replacement may implement “add”.
3. Which request sees the new set, without changing a running invocation's loadout; how admission, `info`, command
   expansion and replay read that same revision. Preserve sessions with explicit tool allowlists.
4. How a failed validation/start/activation is reported without exposing a half-loaded capability or rolling back a
   consumed remote effect. No swallowed error, arbitrary retry or silent fallback parsing.
5. How accepted content is sealed/identified and a later out-of-band edit is diagnosed, rather than silently becoming
   a different tool under the same identity. This need not be an event-sourcing framework.
6. How restart reconstructs accepted additions and diagnoses an unavailable dependency/credential/server. Decide whether
   a required accepted addition blocks reopen or is reported unavailable; never silently skip it.
7. How package upgrades handle a newly introduced name/dependency conflict with a retained addition. Preserve its data,
   report the conflict and require an explicit resolution; never overwrite/delete it to make startup green.

Accepted entries are not rewritten as the base definition. Replacement/removal semantics, dynamic channels/schedules,
a general extension marketplace and automatic OS/global dependency installation are not in this first scope. Runtime
code execution has the instance process's authority unless the host supplies a real isolation boundary.

## 7. Current implementation review and spike evidence

| Current boundary | Conflict with this target |
|---|---|
| `prepareDefinition` writes `.fastagent/registry.ts` and secrets manifest while opening | An installed built definition must not be rebuilt or written during instance open |
| `loadConfig` reads only `fastagent.config.ts` | Precompiled JS configuration needs an explicit built-definition loader |
| `agentDir` supplies cwd, value file, local bindings and clone locations | Different `stateDir` values are not enough to select independent instance environments/work files |
| Text sections tell an agent its cwd holds its mutable definition | The base package will be immutable; prompts must describe working files and additions accurately |
| Deploy copies the author directory and replaces the writable definition | Deploy must consume the selected artifact and preserve instance-owned additions/work/data |
| Documentation treats runtime self-edit and vendored source as the model | Keep that as 0.29.0 history, not the target for installed artifacts |

Disposable probes on 0.29.0 established:

- A filtered source tarball ran after extraction outside the author's directory on Node 26.11.1, Bun 1.4.4 and native
  Linux ARM64/Node 24.15.0, including tools/JSON assets, text/skills/prompts, official Filesystem MCP 2.1.0 and HTTP calls.
- A source dependency under `node_modules` failed on Node with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`.
  A compiled definition/registry entry imported, but the current directory opener generated TS again; outside
  `node_modules`, it ignored the `.js` config and reported `missing_model`. No built-definition loader was implemented.
- A read-only definition failed when generating `.fastagent`, despite an external state directory.
- An npm `files` allowlist still included a nested skill `.env`; `package-lock.json` was omitted. A shrinkwrap was
  packaged when explicitly included, not proof of reproducibility across all embedding installations.
- Two instances of one definition with different `stateDir` values shared tool cwd, relative outputs, local content
  bindings and default values. Process cwd/environment stayed unchanged.

These are experiments, not a supported format, performance benchmark or runtime-addition acceptance. Temporary files
and images were deleted. [#896](https://github.com/fastagent-sh/fastagent/issues/896) remains an independent provider
resource cleanup bug; this refactor cannot claim to fix it by changing paths.

## 8. Design review and implementation gates

1. Review export/layout, `context.json` alternatives and instance paths against actual author/CLI/host/deploy tasks.
2. Build a compiled-entry spike with read-only package resources and an explicit instance root/cwd. Verify Node/Bun,
   package installation, assets, two opens and deployment from the same artifact.
3. Prove additions in increasing difficulty: text, MCP acquisition, script tools, then native tools only if its lifecycle
   can be demonstrated. Record supported activation timing; runtime addition does not necessarily mean in-place reload.
4. Decide durable activation/recovery/upgrade-conflict behavior before implementing a public addition API. Include
   failure injection, cancellation, instance close and unchanged base-package hashes in the tests.
5. Move one assembly responsibility at a time. Preserve Agent API outputs/errors, auth gates, storage integrity and
   current conformance tests; review any necessary SPEC change separately. Keep development source edits in the author
   workflow rather than introducing another runtime definition precedence chain.

Out of scope: context packages, Registry/MCPB, sandbox implementation, orchestration/scale-out, a safe untrusted-package
preview, and automatic mutation of the selected base package. Public API spellings and permanent test counts are not
success criteria; a read-only artifact, correctly owned instance and observable addition lifecycle are.
