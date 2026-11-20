/**
 * Remote `fastagent login` / `logout` / `login --check` over a deployed instance's Auth HTTP API (`--url` or `--remote`).
 * Uses the same `LoginIO` and non-interactive exit-2 contract as local login, without SSH or touching local auth files.
 */
import { createServer } from "node:http";
import {
  type Agent,
  AgentError,
  type AuthApi,
  type AuthFlowState,
  type AuthMethod,
  type AuthProviderStatus,
} from "@fastagent-sh/client/agent-api";
import { failStartup, failUsage } from "./fail.ts";
import { type LoginIO, isInteractive, printReport, terminalLoginIO } from "./login-ui.ts";

const methodWord = (method: AuthMethod) => (method === "oauth" ? "account" : "api-key");

const refusal = (error: unknown) =>
  error instanceof AgentError ? new Error(`${error.code}: ${error.message}`) : error;

function targetFlag(opts: { url?: string; remote?: string }): string {
  if (opts.remote !== undefined) return `--remote ${opts.remote}`;
  return `--url ${opts.url ?? ""}`;
}

function statusHint(provider: AuthProviderStatus): string {
  if (provider.error !== undefined) return `error: ${provider.error}`;
  if (provider.authenticated) return `✓ ${provider.source ?? "configured"}`;
  return "not configured";
}

/**
 * Best-effort local loopback callback listener when a remote OAuth URL uses `redirect_uri=http://localhost:<port>/...`.
 * If the port is free, captures the browser redirect on the operator's machine and resolves with the full redirect URL;
 * if the port is unavailable or the signal aborts, settles to `undefined` so the manual prompt continues seamlessly.
 */
export function listenLocalRedirect(authUrl: string, signal: AbortSignal): Promise<string | undefined> {
  let redirect: URL;
  let expectedState: string | null = null;
  try {
    const parsedAuth = new URL(authUrl);
    expectedState = parsedAuth.searchParams.get("state");
    const raw = parsedAuth.searchParams.get("redirect_uri");
    if (!raw) return Promise.resolve(undefined);
    redirect = new URL(raw);
  } catch {
    return Promise.resolve(undefined);
  }
  if (redirect.protocol !== "http:" || (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1")) {
    return Promise.resolve(undefined);
  }
  const port = Number(redirect.port);
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(undefined);

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      server.close();
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    const server = createServer((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405).end("Method not allowed");
        return;
      }
      const reqUrl = new URL(req.url ?? "/", `http://${redirect.host}`);
      if (reqUrl.pathname !== redirect.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      if (expectedState !== null && reqUrl.searchParams.get("state") !== expectedState) {
        res.writeHead(400).end("Invalid OAuth state");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<html><body><h2>Signed in.</h2><p>You can close this tab and return to your terminal.</p></body></html>");
      finish(reqUrl.toString());
    });
    server.on("error", () => finish(undefined));
    signal.addEventListener("abort", onAbort, { once: true });
    server.listen(port, "127.0.0.1");
  });
}

async function resolveProviderAndMethod(
  providers: readonly AuthProviderStatus[],
  givenProvider: string | undefined,
  givenMethod: AuthMethod | undefined,
  interactive: boolean,
  target: { url?: string; remote?: string; json?: boolean },
  io: LoginIO,
): Promise<{ provider: AuthProviderStatus; method: AuthMethod }> {
  const interactiveProviders = providers.filter((p) => p.methods.length > 0);
  if (interactiveProviders.length === 0) {
    failStartup(new Error("this instance offers no providers with interactive login"));
  }

  let provider: AuthProviderStatus | undefined;
  if (givenProvider !== undefined) {
    const needle = givenProvider.trim().toLowerCase();
    provider = interactiveProviders.find((p) => p.provider.toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (provider === undefined) {
      failUsage(`unknown provider "${givenProvider}" on this instance`);
    }
  } else if (!interactive) {
    const flag = targetFlag(target);
    const choices = interactiveProviders.flatMap((p) =>
      p.methods.map((m) => ({
        provider: p.provider,
        name: p.name,
        method: methodWord(m),
        authenticated: p.authenticated,
        command: `fastagent login ${p.provider} --method ${methodWord(m)} ${flag}`,
      })),
    );
    printReport(target.json, { status: "need_choice", message: "choose a provider to sign in to", choices }, [
      "Choose a provider to sign in to:",
      ...choices.map((c) => `  ${c.command}  (${c.name}, ${c.method})`),
    ]);
    process.exit(2);
  } else {
    const chosenId = await io.select(
      "Select provider to log in to:",
      interactiveProviders.map((p) => ({ value: p.provider, label: p.name, hint: statusHint(p) })),
    );
    if (chosenId === undefined) {
      console.error("[fastagent] login cancelled");
      process.exit(1);
    }
    provider = interactiveProviders.find((p) => p.provider === chosenId);
  }

  if (provider === undefined) {
    console.error("[fastagent] login cancelled");
    process.exit(1);
  }

  let method = givenMethod;
  if (method !== undefined) {
    if (!provider.methods.includes(method)) {
      failUsage(
        `provider "${provider.provider}" does not support --method ${methodWord(method)} (available: ${provider.methods.map(methodWord).join(", ")})`,
      );
    }
  } else if (provider.methods.length === 1) {
    method = provider.methods[0] as AuthMethod;
  } else if (!interactive) {
    const flag = targetFlag(target);
    const choices = provider.methods.map((m) => ({
      provider: provider.provider,
      method: methodWord(m),
      command: `fastagent login ${provider.provider} --method ${methodWord(m)} ${flag}`,
    }));
    printReport(
      target.json,
      { status: "need_choice", provider: provider.provider, message: "choose a sign-in method", choices },
      [`Provider "${provider.provider}" offers multiple sign-in methods:`, ...choices.map((c) => `  ${c.command}`)],
    );
    process.exit(2);
  } else {
    const chosenMethod = await io.select(
      `How would you like to sign in to ${provider.name}?`,
      provider.methods.map((m) => ({
        value: m,
        label: m === "oauth" ? "Sign in with an account (OAuth)" : "Sign in with an API key",
      })),
    );
    if (chosenMethod === undefined) {
      console.error("[fastagent] login cancelled");
      process.exit(1);
    }
    method = chosenMethod as AuthMethod;
  }

  return { provider, method };
}

export async function runRemoteLogin(
  auth: AuthApi,
  label: string,
  givenProvider: string | undefined,
  opts: {
    method?: AuthMethod;
    input?: boolean;
    json?: boolean;
    timeoutSeconds?: number;
    url?: string;
    remote?: string;
  },
  io: LoginIO = terminalLoginIO(),
): Promise<void> {
  const interactive = opts.input !== false && opts.json !== true && isInteractive();
  const providers = await auth.providers().catch((error: unknown) => failStartup(refusal(error)));
  const { provider, method } = await resolveProviderAndMethod(
    providers,
    givenProvider,
    opts.method,
    interactive,
    opts,
    io,
  );

  if (!interactive) {
    const flag = targetFlag(opts);
    const command = `fastagent login ${provider.provider} --method ${methodWord(method)} ${flag}`;
    const check = `fastagent login ${provider.provider} --check ${flag} --json`;
    printReport(
      opts.json,
      {
        status: "need_user_action",
        provider: provider.provider,
        method: methodWord(method),
        target: label,
        command,
        check,
        message: `run in a terminal to sign in to ${provider.name} on ${label}`,
      },
      [`Sign in to ${provider.name} on ${label} from a terminal:`, `  ${command}`, `Verify with:`, `  ${check}`],
    );
    process.exit(2);
  }

  const timeout = opts.timeoutSeconds === undefined ? undefined : AbortSignal.timeout(opts.timeoutSeconds * 1000);
  let flow: AuthFlowState;
  try {
    flow = await auth.startLogin({ provider: provider.provider, method }, ...(timeout ? [{ signal: timeout }] : []));
  } catch (error) {
    if (timeout?.aborted) failStartup(new Error(`login timed out after ${opts.timeoutSeconds}s (--timeout)`));
    failStartup(refusal(error));
  }

  let seenMessages = 0;
  let shownAuthUrl: string | undefined;
  let shownDeviceCode: string | undefined;

  const announce = (state: AuthFlowState) => {
    for (let i = seenMessages; i < state.messages.length; i += 1) {
      io.note(state.messages[i] as string);
    }
    seenMessages = state.messages.length;
    if (state.authUrl !== undefined && state.authUrl.url !== shownAuthUrl) {
      shownAuthUrl = state.authUrl.url;
      io.note(`Open this URL to authorize:\n  ${state.authUrl.url}`);
      if (state.authUrl.instructions) io.note(state.authUrl.instructions);
      io.openUrl(state.authUrl.url);
    }
    if (state.deviceCode !== undefined && state.deviceCode.userCode !== shownDeviceCode) {
      shownDeviceCode = state.deviceCode.userCode;
      io.note(`Go to ${state.deviceCode.verificationUri} and enter the code:  ${state.deviceCode.userCode}`);
      io.openUrl(state.deviceCode.verificationUri, state.deviceCode.userCode);
    }
  };

  try {
    for (;;) {
      announce(flow);
      if (flow.status === "completed") {
        console.error(
          method === "oauth"
            ? `[fastagent] logged in to ${provider.name} on ${label} (stored in instance storage)`
            : `[fastagent] saved the API key for ${provider.name} on ${label} (stored in instance storage)`,
        );
        return;
      }
      if (flow.status === "canceled") {
        console.error("[fastagent] login cancelled");
        process.exit(1);
      }
      if (flow.status === "failed") {
        failStartup(new Error(flow.error ?? `login to ${provider.name} failed`));
      }

      if (flow.status === "awaiting_input" && flow.prompt !== undefined) {
        const activePrompt = flow.prompt;
        let answer: string | undefined;
        if (activePrompt.type === "select") {
          answer = await io.select(
            activePrompt.message,
            (activePrompt.options ?? []).map((o) => ({
              value: o.id,
              label: o.label,
              ...(o.description === undefined ? {} : { hint: o.description }),
            })),
          );
        } else if (activePrompt.type === "manual_code" && flow.authUrl !== undefined) {
          const raceAbort = new AbortController();
          const promptSignal = timeout ? AbortSignal.any([timeout, raceAbort.signal]) : raceAbort.signal;
          const callbackPromise = listenLocalRedirect(flow.authUrl.url, raceAbort.signal);
          const promptPromise = io.prompt(activePrompt.message, { redirect: true, signal: promptSignal });
          // Suppress expected abort rejection if the local callback wins the race.
          void promptPromise.catch(() => undefined);
          try {
            const winner = await Promise.race([
              callbackPromise.then((value) =>
                value === undefined ? new Promise<never>(() => {}) : { kind: "cb" as const, value },
              ),
              promptPromise.then((value) => ({ kind: "prompt" as const, value })),
            ]);
            answer = winner.value;
          } finally {
            raceAbort.abort();
          }
        } else {
          answer = await io.prompt(activePrompt.message, {
            hidden: activePrompt.type === "secret",
            redirect: activePrompt.type === "manual_code",
            ...(timeout ? { signal: timeout } : {}),
          });
        }
        if (answer === undefined) {
          await auth.cancelLogin(flow.flowId).catch(() => undefined);
          console.error("[fastagent] login cancelled");
          process.exit(1);
        }
        flow = await auth.submitInput(
          flow.flowId,
          { promptId: activePrompt.id, value: answer },
          ...(timeout ? [{ signal: timeout }] : []),
        );
      } else {
        flow = await auth.getLogin(flow.flowId, { wait: 30, ...(timeout ? { signal: timeout } : {}) });
      }
    }
  } catch (error) {
    await auth.cancelLogin(flow.flowId).catch(() => undefined);
    if (timeout?.aborted) failStartup(new Error(`login timed out after ${opts.timeoutSeconds}s (--timeout)`));
    failStartup(refusal(error));
  }
}

export async function runRemoteLogout(
  auth: AuthApi,
  label: string,
  givenProvider: string | undefined,
  opts: { input?: boolean },
  io: LoginIO = terminalLoginIO(),
): Promise<void> {
  const providers = await auth.providers().catch((error: unknown) => failStartup(refusal(error)));
  const stored = providers.filter((p) => p.stored !== undefined);
  const held = stored.length === 0 ? "it holds none" : `it holds ${stored.map((p) => p.provider).join(", ")}`;

  let chosen: AuthProviderStatus | undefined;
  if (givenProvider !== undefined) {
    const needle = givenProvider.trim().toLowerCase();
    chosen = stored.find((p) => p.provider.toLowerCase() === needle || p.name.toLowerCase() === needle);
    if (chosen === undefined) {
      failStartup(new Error(`no credential for "${givenProvider}" is stored on ${label}: ${held}`));
    }
  } else if (stored.length === 0) {
    console.error(`[fastagent] no credential is stored on ${label}; environment variables are not login's to remove`);
    return;
  } else if (opts.input === false || !isInteractive()) {
    failUsage(`name the provider to log out of on ${label}: ${held}`);
  } else {
    const picked = await io.select(
      `Select provider to logout on ${label}:`,
      stored.map((p) => ({ value: p.provider, label: p.name, hint: p.stored === "oauth" ? "account" : "API key" })),
    );
    chosen = stored.find((p) => p.provider === picked);
    if (chosen === undefined) {
      console.error("[fastagent] logout cancelled");
      process.exit(1);
    }
  }

  const { removed } = await auth.logout(chosen.provider).catch((error: unknown) => failStartup(refusal(error)));
  if (!removed) {
    failStartup(new Error(`no credential for "${chosen.provider}" is stored on ${label}`));
  }
  console.error(
    chosen.stored === "oauth"
      ? `[fastagent] logged out of ${chosen.name} on ${label} — removed from instance storage`
      : `[fastagent] removed the stored API key for ${chosen.name} on ${label}; environment variables are unchanged`,
  );
}

export async function runRemoteLoginCheck(
  agent: Pick<Agent, "info">,
  auth: AuthApi,
  label: string,
  target: string | undefined,
  opts: { json?: boolean; url?: string; remote?: string },
): Promise<void> {
  if (target === undefined || target.trim() === "") {
    failUsage("pass a provider id or provider/modelId to --check");
  }
  let providerNeedle = target.trim().toLowerCase();
  if (target.includes("/")) {
    const slash = target.indexOf("/");
    const providerId = target.slice(0, slash);
    const modelId = target.slice(slash + 1);
    const info = await agent.info().catch((error: unknown) => failStartup(refusal(error)));
    if (
      providerId === "" ||
      modelId === "" ||
      !info.models.some((model) => model.provider === providerId && model.modelId === modelId)
    ) {
      failUsage(`unknown model "${target}" on ${label}`);
    }
    providerNeedle = providerId.toLowerCase();
  }
  const providers = await auth.providers().catch((error: unknown) => failStartup(refusal(error)));
  const found = providers.find(
    (p) => p.provider.toLowerCase() === providerNeedle || p.name.toLowerCase() === providerNeedle,
  );
  if (found === undefined) {
    printReport(opts.json, { status: "not_ready", provider: target, reason: "provider_not_found", remote: label }, [
      `not_ready: unknown provider "${target}" on ${label}`,
    ]);
    process.exit(1);
  }
  if (found.error !== undefined) {
    printReport(
      opts.json,
      { status: "invalid", provider: found.provider, reason: "invalid_state", error: found.error, remote: label },
      [`invalid: ${found.name} on ${label} (${found.error})`],
    );
    process.exit(2);
  }
  if (found.authenticated) {
    printReport(
      opts.json,
      {
        status: "ready",
        provider: found.provider,
        source: found.source ?? null,
        stored: found.stored ?? null,
        remote: label,
      },
      [`ready: ${found.name} on ${label} (${found.source ?? "configured"})`],
    );
    return;
  }
  const flag = targetFlag(opts);
  printReport(
    opts.json,
    {
      status: "not_ready",
      provider: found.provider,
      reason: "credentials_not_configured",
      remote: label,
      next: `fastagent login ${found.provider} ${flag}`,
    },
    [`not_ready: ${found.name} on ${label}`, `  fastagent login ${found.provider} ${flag}`],
  );
  process.exit(1);
}
