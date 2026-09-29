import { spawn } from "node:child_process";

/**
 * How to hand `url` to the default browser on `platform`, or undefined when it must not be handed over at all.
 *
 * Only a web page: `https:`, or `http:` on a loopback host. Some callers pass URLs they did not build — a deployed box's
 * login relays its own (`cli/login-relay.ts`), and that box runs code its agent can rewrite — and the platform openers
 * open anything: a local path, a `file:`/`smb:` URL, an argument that starts with `-`. Parsed and re-serialized, so
 * what reaches the opener is what was checked. No shell anywhere: on Windows `start` needs one, and cmd reads the `&`
 * every OAuth URL carries as a command separator, so `rundll32 url.dll,FileProtocolHandler` takes the URL as one
 * argument instead.
 */
export function browserCommand(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // not a URL: nothing to open
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback))) return undefined;
  const href = parsed.href;
  if (platform === "darwin") return { cmd: "open", args: [href] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", href] };
  return { cmd: "xdg-open", args: [href] };
}

/** Best-effort open a URL in the default browser (callers print it too). A URL that is not a web page is refused, visibly. */
export function openExternalUrl(url: string): void {
  const command = browserCommand(url, process.platform);
  if (!command) {
    console.error(
      `[fastagent] not opening ${JSON.stringify(url)} in a browser: only an https (or loopback http) URL is`,
    );
    return;
  }
  spawn(command.cmd, command.args, { stdio: "ignore", detached: true }).on("error", () => {});
}
