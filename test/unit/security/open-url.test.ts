import { describe, expect, it } from "vitest";
import { browserCommand } from "../../../src/open-url.ts";

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
});
