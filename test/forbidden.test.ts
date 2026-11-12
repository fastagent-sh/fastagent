import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { takeRefused } from "./forbidden.ts";

/** A resolver that answers `address` for any name, in the form the caller asks for (one address, or all of them). */
const resolvesTo =
  (address: string) =>
  (_host: string, options: { all?: boolean }, callback: (...answer: unknown[]) => void): void => {
    if (options.all) callback(null, [{ address, family: net.isIP(address) }]);
    else callback(null, address, net.isIP(address));
  };

/** How a socket ends: its error's message, or "connected". */
const outcome = (socket: net.Socket): Promise<string> =>
  new Promise((resolve) => {
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (error) => resolve(error.message));
  });

afterEach(() => {
  takeRefused();
});

describe("the network guard every tier installs (test/setup.ts)", () => {
  it("refuses an address off the machine, through net.connect as through the socket itself", () => {
    expect(() => net.connect(80, "192.0.2.1")).toThrow("a connection to 192.0.2.1, which is not loopback");
    expect(() => net.createConnection({ host: "192.0.2.1", port: 80 })).toThrow(/not loopback/);
    expect(() => new net.Socket().connect(80, "192.0.2.1")).toThrow(/not loopback/);
    expect(takeRefused()).toHaveLength(3);
  });

  it("refuses a name by the address it resolves to, before it connects", async () => {
    const socket = net.connect({ host: "far.example", port: 80, lookup: resolvesTo("192.0.2.1") as never });
    expect(await outcome(socket)).toContain("a connection to far.example (192.0.2.1), which is not loopback");
    expect(takeRefused()).toHaveLength(1);
  });

  it("lets a name through that resolves to loopback, as undici's HTTP proxy resolves its origin", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const socket = net.connect({ host: "external.invalid", port, lookup: resolvesTo("127.0.0.1") as never });
      expect(await outcome(socket)).toBe("connected");
      expect(takeRefused()).toEqual([]);
    } finally {
      server.close();
    }
  });
});
