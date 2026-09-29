import { describe, expect, it } from "vitest";
import { browserCommand } from "../src/open-url.ts";

describe("browserCommand: only a web page reaches the platform's opener", () => {
  const oauth = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&state=s";

  it("opens https, and http only on a loopback host", () => {
    expect(browserCommand(oauth, "darwin")).toEqual({ cmd: "open", args: [oauth] });
    expect(browserCommand("http://localhost:1455/auth/callback", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["http://localhost:1455/auth/callback"],
    });
    expect(browserCommand("http://127.0.0.1:8787/", "darwin")?.args).toEqual(["http://127.0.0.1:8787/"]);
  });

  it("refuses what an opener would treat as something other than a page", () => {
    // A deployed box relays its own URLs, and the box runs code its agent can rewrite.
    for (const url of [
      "http://evil.example/",
      "file:///etc/passwd",
      "smb://host/share",
      "/Applications/Calculator.app",
      "-a Calculator",
      "javascript:alert(1)",
      "",
    ]) {
      expect(browserCommand(url, "darwin"), url).toBeUndefined();
    }
  });

  it("on Windows hands the URL over as one argument, with no shell to split it at its '&'", () => {
    expect(browserCommand(oauth, "win32")).toEqual({ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", oauth] });
    // What reaches the opener is the parsed URL, so a payload cannot ride along unescaped.
    expect(browserCommand('https://x.example/?q=" & calc & "', "win32")?.args[1]).toBe(
      "https://x.example/?q=%22%20&%20calc%20&%20%22",
    );
  });
});
