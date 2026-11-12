/**
 * What a test tier forbids (CONTRIBUTING.md, "Test tiers"), installed by its setup file. A forbidden call throws where it
 * is made, and is also recorded and failed after the test: product code may catch the throw (`src/git.ts` reads a spawn
 * that fails as "no git"), and work a test leaves running can make the call after the test has ended.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { afterAll, afterEach } from "vitest";

const refused: string[] = [];

function refuse(what: string): Error {
  const where = (new Error().stack ?? "")
    .split("\n")
    .filter((line) => /\/(src|test)\//.test(line) && !line.includes("test/forbidden.ts"))
    .slice(0, 3)
    .join("\n");
  const error = new Error(`${what}\n${where}`);
  refused.push(error.message);
  return error;
}

/** What was refused since the last test, cleared: for the test of this file's own guards. */
export function takeRefused(): string[] {
  return refused.splice(0);
}

function failIfRefused(): void {
  if (refused.length === 0) return;
  const found = refused.splice(0).join("\n\n");
  throw new Error(`this test did what its tier forbids (CONTRIBUTING.md, "Test tiers"):\n\n${found}`);
}

afterEach(failIfRefused);
afterAll(failIfRefused);

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/i;

function hostOf(args: unknown[]): string | undefined {
  // `net.connect` hands `Socket#connect` its arguments already normalized, as one array.
  const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: string; path?: string };
    return options.path ? undefined : (options.host ?? "localhost");
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined; // a pipe or a Unix socket's path
  return typeof second === "string" ? second : "localhost";
}

/**
 * No connection leaves the machine: a test that needs a server serves one on loopback. A name is judged by the address it
 * resolves to, since a dispatcher may resolve it to somewhere else (undici's HTTP proxy resolves the origin to the proxy).
 */
export function forbidNetwork(): void {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const host = hostOf(args);
    if (host !== undefined && net.isIP(host) !== 0 && !LOOPBACK.test(host)) {
      throw refuse(`a connection to ${host}, which is not loopback`);
    }
    if (host !== undefined && net.isIP(host) === 0) {
      this.once("lookup", (error: Error | null, address: string) => {
        if (error === null && !LOOPBACK.test(address)) {
          this.destroy(refuse(`a connection to ${host} (${address}), which is not loopback`));
        }
      });
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;
}

/** The test runs in this process: no child process, whoever starts it. */
export function forbidProcesses(): void {
  const prototype = (childProcess.ChildProcess as unknown as { prototype: { spawn: (options: unknown) => unknown } })
    .prototype;
  prototype.spawn = (options: unknown) => {
    const { file, args = [] } = options as { file?: string; args?: string[] };
    throw refuse(`a child process: ${[file, ...args.slice(1)].join(" ").slice(0, 200)}`);
  };
  for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
    (childProcess as Record<string, unknown>)[name] = (file: string) => {
      throw refuse(`a child process: ${String(file).slice(0, 200)} (${name})`);
    };
  }
  syncBuiltinESMExports();
}
