import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { bindAddress, bindLabel, classifyBind, isBindAddress } from "../../../packages/fastagent/src/bind.ts";
import { baseEnv, processEnvironment } from "../../../packages/fastagent/src/child-env.ts";
import { enterInstance } from "../../../packages/fastagent/src/cli/instance.ts";
import {
  describeSecrets,
  missingSecrets,
  redactValues,
  revealValues,
} from "../../../packages/fastagent/src/declared-secrets.ts";
import { apiKeysFrom } from "../../../packages/fastagent/src/http/server.ts";
import { INSTANCE_NAME_ENV } from "../../../packages/fastagent/src/instance-name.ts";
import { INSTANCE_ROOT_ENV } from "../../../packages/fastagent/src/paths.ts";
import { secretEquals } from "../../../packages/fastagent/src/http/secret.ts";
import { browserCommand } from "../../../packages/fastagent/src/open-url.ts";

describe("browserCommand: only a web page reaches the platform's opener", () => {
  const oauth = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&state=s";

  it("opens https and loopback http without a shell across darwin, linux, and win32", () => {
    expect(browserCommand(oauth, "darwin")).toEqual({ cmd: "open", args: [oauth] });
    expect(browserCommand(oauth, "win32")).toEqual({
      cmd: "rundll32",
      args: ["url.dll,FileProtocolHandler", oauth],
    });
    expect(browserCommand("http://localhost:1455/auth/callback", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["http://localhost:1455/auth/callback"],
    });
    expect(browserCommand("http://127.0.0.1:8787/", "darwin")?.args).toEqual(["http://127.0.0.1:8787/"]);
    expect(browserCommand("http://[::1]:8787/cb", "linux")?.args).toEqual(["http://[::1]:8787/cb"]);
  });

  it("refuses non-web schemes, remote http, lookalike loopback hosts, flags, and malformed URLs", () => {
    const refused = [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://files.internal/share",
      "http://evil.example/oauth",
      "http://127.0.0.1.evil.example/cb",
      "http://localhost.evil.example/cb",
      "-a /Applications/Calculator.app",
      "not a url",
      "",
    ];
    for (const url of refused) {
      expect(browserCommand(url, "darwin"), url).toBeUndefined();
      expect(browserCommand(url, "win32"), url).toBeUndefined();
    }
  });
});

describe("child-env: host secrets never leak into spawned processes", () => {
  it("baseEnv passes only the allowlist and LC_* variables, stripping ambient host credentials", () => {
    expect(
      baseEnv({
        PATH: "/usr/bin",
        HOME: "/home/app",
        LC_ALL: "C.UTF-8",
        HTTPS_PROXY: "http://proxy.internal:8080",
        OPENAI_API_KEY: "sk-host-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        FASTAGENT_API_KEY: "fa-key",
        FASTAGENT_DATABASE_URL: "postgres://secret",
        GH_TOKEN: "ghp_undeclared",
        EMPTY: undefined,
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/app",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "http://proxy.internal:8080",
    });
  });

  it("processEnvironment adds only declared secrets that are held, plus the git ceiling", () => {
    expect(
      processEnvironment(
        {
          base: { PATH: "/bin", HOME: "/h" },
          secrets: { GH_TOKEN: "t", OTHER: "o", EMPTY: undefined },
          declared: ["GH_TOKEN", "EMPTY", "NOT_GIVEN"],
          workdir: "/srv/agent/work",
        },
        "/srv/agent",
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/h",
      GH_TOKEN: "t",
      GIT_CEILING_DIRECTORIES: "/srv/agent",
    });
  });
});

describe("bind address parsing and classification", () => {
  it("accepts localhost and IPv4/IPv6 literals, and classifies wildcard, loopback, and specific interfaces", () => {
    for (const valid of [
      "localhost",
      "127.0.0.1",
      "127.0.1.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "0.0.0.0",
      "::",
      "10.0.0.5",
    ]) {
      expect(isBindAddress(valid), valid).toBe(true);
    }
    expect(bindAddress("localhost")).toBe("127.0.0.1");
    expect(bindAddress("10.0.0.5")).toBe("10.0.0.5");
    expect(classifyBind(undefined)).toBe("wildcard");
    expect(classifyBind("0.0.0.0")).toBe("wildcard");
    expect(classifyBind("::")).toBe("wildcard");
    expect(classifyBind("localhost")).toBe("loopback");
    expect(classifyBind("127.0.0.1")).toBe("loopback");
    expect(classifyBind("[::1]")).toBe("loopback");
    expect(classifyBind("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyBind("10.0.0.5")).toBe("specific");
    expect(bindLabel("0.0.0.0", 8787)).toBe("port 8787");
    expect(bindLabel("::1", 8787)).toBe("[::1]:8787");
  });

  it("refuses hostnames, half-bracketed IPv6, URLs, and empty values", () => {
    for (const invalid of ["example.com", "localhost.localdomain", "[::1", "::1]", "http://127.0.0.1", "", "   "]) {
      expect(isBindAddress(invalid), invalid).toBe(false);
    }
  });
});

describe("secretEquals", () => {
  it("compares equal/unequal strings, including length mismatches (no throw)", () => {
    expect(secretEquals("secret", "secret")).toBe(true);
    expect(secretEquals("secret", "secreT")).toBe(false);
    expect(secretEquals("secret", "secret-longer")).toBe(false);
  });

  it("never matches a missing or empty secret, whatever is given", () => {
    // A gate whose secret was never configured must not be passed by sending none.
    expect(secretEquals("", "")).toBe(false);
    expect(secretEquals("", undefined)).toBe(false);
    expect(secretEquals(undefined, "secret")).toBe(false);
    expect(secretEquals(null, "secret")).toBe(false);
    expect(secretEquals(42, "42")).toBe(false);
  });
});

describe("declared secrets: the rule", () => {
  it("reports only names with no value, grouped by the file to open", () => {
    const declared = [
      { name: "X_API_KEY", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "X_API_SECRET", declaredIn: "src/tools/x-post.ts", optional: false },
      { name: "WEBHOOK_SECRET", declaredIn: "src/tools/notify.ts", optional: false },
    ];
    const env = { X_API_KEY: "k", X_API_SECRET: "" }; // empty counts as missing (an unset .env line)
    expect(missingSecrets(declared, env).map((s) => s.name)).toEqual(["X_API_SECRET", "WEBHOOK_SECRET"]);
    expect(describeSecrets(declared)).toBe(
      "X_API_KEY, X_API_SECRET (src/tools/x-post.ts); WEBHOOK_SECRET (src/tools/notify.ts)",
    );
  });

  it("keeps runtime secret maps and API keys redacted in strings, JSON, and inspect output until unwrapped", () => {
    const rawSecret = "sk-live-super-secret-value";
    const rawApiKey = "fa-api-key-super-secret";
    const redacted = redactValues({ API_TOKEN: rawSecret, EMPTY: "", UNSET: undefined });
    const keys = apiKeysFrom(`${rawApiKey}, second-key`);

    expect(Redacted.isRedacted(redacted.API_TOKEN)).toBe(true);
    expect(keys.every((k) => Redacted.isRedacted(k))).toBe(true);
    expect(String(redacted.API_TOKEN)).not.toContain(rawSecret);
    expect(JSON.stringify(redacted)).not.toContain(rawSecret);
    expect(inspect(redacted)).not.toContain(rawSecret);
    expect(JSON.stringify(keys)).not.toContain(rawApiKey);
    expect(inspect(keys)).not.toContain(rawApiKey);
    expect(revealValues(redacted)).toEqual({ API_TOKEN: rawSecret, EMPTY: "" });
    expect(keys.map((k) => Redacted.value(k))).toEqual([rawApiKey, "second-key"]);
    expect(missingSecrets([{ name: "API_TOKEN", declaredIn: "a.ts", optional: false }], redacted)).toEqual([]);
    expect(
      missingSecrets([{ name: "EMPTY", declaredIn: "a.ts", optional: false }], redacted).map((s) => s.name),
    ).toEqual(["EMPTY"]);
  });

  it("resolves --root and --name via enterInstance without mutating process.env", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-enter-inst-"));
    const customRoot = join(dir, "custom-root");
    const beforeRoot = process.env[INSTANCE_ROOT_ENV];
    const beforeName = process.env[INSTANCE_NAME_ENV];
    try {
      const entered = enterInstance(dir, { root: customRoot, name: "tenant_a" });
      expect(entered.root).toBe(customRoot);
      expect(entered.name).toBe("tenant_a");
      expect(entered.env[INSTANCE_ROOT_ENV]).toBe(customRoot);
      expect(entered.env[INSTANCE_NAME_ENV]).toBe("tenant_a");
      expect(process.env[INSTANCE_ROOT_ENV]).toBe(beforeRoot);
      expect(process.env[INSTANCE_NAME_ENV]).toBe(beforeName);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
