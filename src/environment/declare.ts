/**
 * WHAT AN AGENT'S ENVIRONMENT IS: the `environment` of `context.json`, read and refused in ONE place, and the backends a
 * package may install from. FastAgent's own format, with mise underneath: `packages` (mise's tool names, each with a
 * version) and `aptPackages` (Debian packages the image installs). Pure: installing it is mise.ts's.
 * docs/design/agent-service.md §4 is the rule.
 */
import { createHash } from "node:crypto";

/** The environment's lock, committed: mise's configuration rendered from the declaration, its lock, the digest. */
export const ENVIRONMENT_DIR = "environment";

/** In {@link ENVIRONMENT_DIR}: the digest of the packages it was rendered from (apt packages are not locked), written last. */
export const ENVIRONMENT_DIGEST_FILE = "packages.sha256";

/** An agent's environment, as declared. */
export interface DeclaredEnvironment {
  /** Package → version: `"latest"`, a prefix (`"2"`) or an exact version. */
  packages: Record<string, string>;
  /** Debian packages the image installs. */
  aptPackages: string[];
}

const ENVIRONMENT_KEYS = ["packages", "aptPackages"] as const;

/** The backends a package may be written with: a release, a conda-forge build, an npm or a PyPI package. */
const WRITTEN_BACKENDS = ["aqua", "github", "gitlab", "conda", "npm", "pypi"] as const;

/** The backends a registry name may resolve to: the written ones, more release hosts, and mise's own runtimes. */
const RESOLVED_BACKENDS: ReadonlySet<string> = new Set([...WRITTEN_BACKENDS, "forgejo", "http", "packslip", "core"]);

/** The backends left out, each with its reason; any other is refused until it is classified. */
const LEFT_OUT: Readonly<Record<string, string>> = {
  go: "builds from source: a whole Go toolchain in the image for one binary",
  cargo: "builds from source: a whole Rust toolchain in the image for one binary",
  spm: "builds from source with Swift",
  gem: "compiles native extensions against Ruby",
  spinel: "compiles Ruby into a binary",
  asdf: "runs a plugin's shell scripts at install, and has no Windows",
  vfox: "runs a plugin's code at install and whenever the environment is entered, and the lock does not pin it",
  dotnet: "needs the .NET SDK, which the environment does not declare yet",
  ubi: "is deprecated in mise",
};

const ALTERNATIVE = "write the project's release with github:<owner>/<repo>, or install it in your own Dockerfile";

/** A registry name: what `mise registry` lists. */
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** What follows a written backend: a package or `owner/repo`, an npm scope included, without mise's `[options]`. */
const BACKEND_NAME = /^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** A Debian package name (Debian Policy §5.6.1). */
const APT_NAME = /^[a-z0-9][a-z0-9+.-]+$/;

/** Read the `environment` of `context.json` (undefined is none). Every refusal names what it refuses. */
export function declareEnvironment(raw: unknown): DeclaredEnvironment | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`"environment" must be an object`);
  const environment = raw as Record<string, unknown>;
  for (const key of Object.keys(environment)) {
    if (!(ENVIRONMENT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`environment: unknown key "${key}" (valid keys: ${ENVIRONMENT_KEYS.join(", ")})`);
    }
  }
  return { packages: declarePackages(environment.packages), aptPackages: declareAptPackages(environment.aptPackages) };
}

function declarePackages(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`environment: "packages" must be an object of versions by package`);
  }
  for (const [name, version] of Object.entries(raw)) {
    const refused = packageNameError(name);
    if (refused) throw new Error(`environment: package "${name}" ${refused}`);
    if (typeof version !== "string") throw new Error(`environment: package "${name}": the version must be a string`);
    const badVersion = versionError(version);
    if (badVersion) throw new Error(`environment: package "${name}": ${badVersion}`);
  }
  return { ...(raw as Record<string, string>) };
}

function declareAptPackages(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`environment: "aptPackages" must be an array of Debian package names`);
  const seen = new Set<string>();
  for (const name of raw) {
    if (typeof name !== "string" || !APT_NAME.test(name)) {
      throw new Error(`environment: apt package ${JSON.stringify(name)} is not a Debian package name`);
    }
    if (seen.has(name)) throw new Error(`environment: apt package "${name}" is listed twice`);
    seen.add(name);
  }
  return [...raw];
}

/** Why `name` cannot name a package, as the rest of a sentence that starts with it; undefined when it can. */
function packageNameError(name: string): string | undefined {
  if (name.includes("[")) return "has mise's [options], which the format does not hold";
  const colon = name.indexOf(":");
  if (colon === -1) return REGISTRY_NAME.test(name) ? undefined : "is not a name from mise's registry";
  const backend = name.slice(0, colon);
  if (backend === "http") {
    return "is written with http:, whose package needs a URL a version cannot hold — a registry name that installs from a URL carries its own";
  }
  if (!(WRITTEN_BACKENDS as readonly string[]).includes(backend)) {
    return `installs with ${backend}:, which ${refusalReason(backend)}`;
  }
  return BACKEND_NAME.test(name.slice(colon + 1)) ? undefined : `does not name a package after "${backend}:"`;
}

/** Why `version` is not one, or undefined. */
function versionError(version: string): string | undefined {
  if (version === "" || /\s/.test(version)) return "the version must be non-empty, without spaces";
  // ref:, path:, prefix:, sub-…: build from source, read this machine, or say what a version already says.
  if (version.includes(":") || version === "system") {
    return `version "${version}" — a version is "latest", a prefix ("2") or an exact version ("2.1.0")`;
  }
  return undefined;
}

/** Why FastAgent does not install from `backend`, as a clause after "which", with what to do instead. */
function refusalReason(backend: string): string {
  const reason =
    LEFT_OUT[backend] ??
    `FastAgent does not install from (a package is a registry name, or written with ` +
      `${WRITTEN_BACKENDS.map((b) => `${b}:`).join(", ")})`;
  return `${reason} — ${ALTERNATIVE}`;
}

/** The backend a package is written with (`npm:prettier` is npm), or undefined for a registry name, which mise resolves. */
export function writtenBackend(name: string): string | undefined {
  const colon = name.indexOf(":");
  return colon === -1 ? undefined : name.slice(0, colon);
}

/**
 * Why the registry name `name`, which mise resolves to `backend` (`cargo:tokei`), is refused; undefined when that
 * backend is allowed.
 */
export function resolvedBackendRefusal(name: string, backend: string): string | undefined {
  const kind = backend.split(":")[0] ?? backend;
  if (RESOLVED_BACKENDS.has(kind)) return undefined;
  return `package "${name}" resolves to ${backend}, which ${refusalReason(kind)}`;
}

/** PyPI packages whose runtime the environment does not declare, and what to declare. */
export interface MissingRuntime {
  packages: string[];
  missing: string[];
}

/**
 * The PyPI packages, written `pypi:` or resolved to it (`backends`, by package), when the environment does not declare
 * both `python` and `uv`: mise takes them from the machine and never adds them, so such a package installs on an
 * author's machine that has them and fails in the image.
 */
export function missingPythonRuntime(
  packages: Record<string, string>,
  backends: ReadonlyMap<string, string>,
): MissingRuntime | undefined {
  const pypi = Object.keys(packages).filter((name) => backends.get(name) === "pypi");
  const missing = ["python", "uv"].filter((tool) => !declaresTool(packages, tool));
  return pypi.length > 0 && missing.length > 0 ? { packages: pypi, missing } : undefined;
}

/** What to tell whoever declared them, with the command that declares the rest. */
export function runtimeAdvice({ packages, missing }: MissingRuntime): string {
  return (
    `${packages.join(", ")} ${packages.length === 1 ? "installs" : "install"} with ${missing.join(" and ")}, which ` +
    `the environment does not declare: mise then uses this machine's, and the image has none — run ` +
    `\`fastagent env add ${missing.join(" ")}\``
  );
}

/** Whether `packages` declares `tool` under any backend or owner: `aqua:astral-sh/uv` is `uv`. */
export function declaresTool(packages: Record<string, string>, tool: string): boolean {
  return Object.keys(packages).some(
    (name) =>
      name
        .slice(name.indexOf(":") + 1)
        .split("/")
        .at(-1) === tool,
  );
}

/** The digest `environment/` records: of the packages alone, in a form that does not depend on their order. */
export function packagesDigest(packages: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`;
}

/**
 * One argument of `fastagent env add`: `gh`, `gh@2`, `npm:@scope/tool@1`, or `apt:chromium` for an apt package. The
 * version is what follows the last `@` after the backend, `latest` without one.
 */
export function parsePackageArgument(arg: string): { apt: string } | { name: string; version: string } {
  if (arg.startsWith("apt:")) return { apt: arg.slice("apt:".length) };
  const at = arg.lastIndexOf("@");
  if (at > arg.indexOf(":") + 1) return { name: arg.slice(0, at), version: arg.slice(at + 1) };
  return { name: arg, version: "latest" };
}
