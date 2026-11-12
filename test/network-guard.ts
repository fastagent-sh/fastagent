/**
 * The network guard of every test tier (AGENTS.md, "Tests"), free of vitest so a child process a test starts
 * can load it too (child-network-guard.ts). A connection to an address off the machine is refused where it is made; a
 * name is judged by the address it resolves to, since a dispatcher may resolve it to somewhere else (undici's HTTP proxy
 * resolves the origin to the proxy).
 */
import net from "node:net";

/** The file a child process writes what it refused to, `\0`-separated, for the test that started it. */
export const CHILD_REFUSALS = "FASTAGENT_TEST_REFUSALS";

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

/** Refuse every connection off the machine with the error `refuse` makes of what was attempted. */
export function refuseConnectionsOffTheMachine(refuse: (what: string) => Error): void {
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
