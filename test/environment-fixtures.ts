import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const savedEnv = { ...process.env };

export const FASTAGENT = { "@fastagent-sh/fastagent": "^0.24.4" };

export async function agentDir(environment?: unknown): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fa-env-")));
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "a", private: true, dependencies: FASTAGENT }));
  if (environment !== undefined) await writeFile(join(dir, "context.json"), JSON.stringify({ environment }));
  return dir;
}

/** A stand-in npm, for PATH: it records what it was asked and installs this platform's mise package, as npm does. */
export async function fakeNpm(dir: string): Promise<string> {
  const fakeBin = await realpath(await mkdtemp(join(tmpdir(), "fa-env-npm-")));
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await writeFile(
    join(fakeBin, "npm"),
    `#!/bin/sh\necho "$*" > "${join(dir, "npm-args")}"\nmkdir -p "${pkg}/bin" && echo '{}' > "${pkg}/package.json" && : > "${pkg}/bin/mise"\n`,
  );
  await chmod(join(fakeBin, "npm"), 0o755);
  return fakeBin;
}

/** One logged mise run: its arguments, where it ran, the isolation it was given, and its PATH's first entry. */
interface MiseCall {
  args: string;
  cwd: string;
  /** MISE_OVERRIDE_CONFIG_FILENAMES, MISE_GLOBAL_CONFIG_FILE and MISE_PYTHON_COMPILE, as it saw them. */
  isolation: string;
  path: string;
  /** FAKE_AGENT_VALUE as it saw it: whose environment it ran in. */
  agentValue: string;
}

/**
 * A stand-in mise where this machine's platform package puts it. It logs each run, and at `install` what the agent's
 * context.json held then. It keeps what it installed in a file beside the agent: `where <spec>` answers for those and
 * fails for any other, as mise does for a package with no install; `install` adds its specs and says what mise says
 * of a package no configuration names, fails when `FAKE_FAIL_INSTALL` is set (with the reason on the lines after, as
 * mise does for several packages, when it is `many`), and sleeps when `FAKE_SLOW` is. It answers
 * `tool <name> --json` and `env --json`.
 */
export async function fakeMise(
  dir: string,
): Promise<{ bin: string; calls: () => Promise<MiseCall[]>; log: () => Promise<string> }> {
  const pkg = join(dir, "node_modules", "@jdxcode", `mise-${process.platform}-${process.arch}`);
  await mkdir(join(pkg, "bin"), { recursive: true });
  await writeFile(join(pkg, "package.json"), `{"name":"@jdxcode/mise-${process.platform}-${process.arch}"}\n`);
  const logFile = join(dir, "..", `${dir.split("/").at(-1)}-mise.log`);
  const installed = join(dir, "..", `${dir.split("/").at(-1)}-mise.installed`);
  const bin = join(pkg, "bin", "mise");
  await writeFile(
    bin,
    `#!/bin/sh
echo "run|$*|$PWD|$MISE_OVERRIDE_CONFIG_FILENAMES,$MISE_GLOBAL_CONFIG_FILE,$MISE_PYTHON_COMPILE|\${PATH%%${delimiter}*}|$FAKE_AGENT_VALUE" >> "${logFile}"
case "$1" in
  where) grep -qxF "$2" "${installed}" 2>/dev/null || { echo "mise ERROR $2 is not installed" >&2; exit 1; } ;;
  install) shift; [ "$1" = --quiet ] && shift
    echo "context.json at install: $(cat "${dir}/context.json" 2>/dev/null | tr -d ' \\n')" >> "${logFile}"
    if [ -n "$FAKE_SLOW" ]; then sleep 2; fi
    if [ "$FAKE_FAIL_INSTALL" = many ]; then
      printf 'mise ERROR Failed to install tools: %s\\nGET https://example.com/jq: 404 Not Found\\nmise ERROR Version: 2026.10.8\\nmise ERROR Run with --verbose or MISE_VERBOSE=1 for more information\\n' "$*" >&2; exit 1
    elif [ -n "$FAKE_FAIL_INSTALL" ]; then echo "mise ERROR no version of jq matches 99" >&2; exit 1; fi
    for spec in "$@"; do echo "$spec" >> "${installed}"; echo "mise $spec ✓ installed" >&2; done
    printf 'mise WARN  %s installed but not activated — it is not in any config file.\\nTo install and activate, run:\\n  mise use %s\\n' "$1" "$1" >&2 ;;
  tool) case "$2" in
      tokei) echo '{"backend":"cargo:tokei"}' ;;
      ansible) echo '{"backend":"pypi:ansible"}' ;;
      nope) echo "mise ERROR nope not found in mise tool registry" >&2; exit 1 ;;
      *) printf '{"backend":"aqua:owner/%s"}' "$2" ;;
    esac ;;
  env) printf '{"PATH":"/fake/tools%s%s","FAKE_TOOL_HOME":"/fake/home"}' "${delimiter}" "$PATH" ;;
esac
`,
  );
  await chmod(bin, 0o755);
  const log = async () => readFile(logFile, "utf8").catch(() => "");
  const calls = async () =>
    (await log())
      .split("\n")
      .filter((line) => line.startsWith("run|"))
      .map((line) => {
        const [, args, cwd, isolation, path, agentValue] = line.split("|") as string[];
        return { args, cwd, isolation, path, agentValue } as MiseCall;
      });
  return { bin, calls, log };
}
