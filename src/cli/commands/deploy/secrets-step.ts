/**
 * A deploy's step that makes the target hold every value the deployment needs (secret-store.ts), written once for the
 * hosts that keep their values in a store of their own: who is asked is the deploy's answerer, and a source is the
 * environment the deploy ran in (the file `--env-file` names laid under it), which it already read.
 */
import { confirm, isCancel, password } from "@clack/prompts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";
import {
  type ProvideSecrets,
  type SecretAsker,
  type SecretCommands,
  type SecretStore,
  provideSecrets,
} from "../../../deploy/secret-store.ts";
import { type DeploymentApi, mintApiKey } from "../../../deploy/api.ts";
import { type ModelKey, declaredNames, secretNeeds } from "../../../deploy/secrets.ts";
import { API_KEY_VARIABLE } from "../../../http/server.ts";
import { displayPath } from "../../../paths.ts";
import { shellArg } from "../../../shell-arg.ts";
import type { Answerer, DeployOptions } from "./shared.ts";

/** The questions of a person at this terminal; a cancel stops the deploy. */
const terminalAsker: SecretAsker = {
  async confirm(question) {
    const answer = await confirm({ message: question, initialValue: true });
    if (isCancel(answer)) throw new Error("cancelled");
    return answer;
  },
  async secret(need) {
    const answer = await password({ message: `${need.name} (${need.hint})` });
    if (isCancel(answer)) throw new Error("cancelled");
    const value = String(answer);
    if (value.trim() === "") throw new Error(`${need.name} is empty`);
    return value;
  },
};

/** The `fastagent secrets` commands for `host` as this deploy would have them run: its agent directory and configuration. */
function secretsCommands(host: string, agentDir: string, config: string | undefined): SecretCommands {
  const agent = displayPath(process.cwd(), agentDir);
  const rest = `${agent === undefined ? "" : ` ${shellArg(agent)}`}${config === undefined ? "" : ` --config ${shellArg(config)}`}`;
  return {
    push: `fastagent secrets push ${host}${rest}`,
    // The Agent API's key is made, never typed: the one value a person has no source for.
    set: (name) => `fastagent secrets set ${host} ${name}${rest}${name === API_KEY_VARIABLE ? " --generate" : ""}`,
  };
}

/** Where a deploy's values come from, as what it says and as the flag that makes `secrets push` read the same. */
function valuesSource(
  values: ReadonlyMap<string, string>,
  valuesFrom: string,
  opts: Pick<DeployOptions, "envFile" | "fromEnv">,
): ProvideSecrets["source"] {
  // `secrets push` takes one source a run, so two sources are two commands: the file's values are not in the
  // environment of the process that runs the second.
  const flags = [
    ...(opts.envFile === undefined ? [] : [`--env-file ${shellArg(opts.envFile)}`]),
    ...(opts.fromEnv ? ["--from-env"] : []),
  ];
  return flags.length === 0 ? undefined : { file: valuesFrom, flags, values };
}

export function deploySecrets(input: {
  host: string;
  label: string;
  agentDir: string;
  opts: Pick<DeployOptions, "config" | "envFile" | "fromEnv">;
  answerer: Answerer;
  api: DeploymentApi;
  modelAuth: string | undefined;
  modelKey: ModelKey;
  declaredSecrets: readonly DeclaredSecret[];
  /** Where this deploy's values are from (`DeployFacts.valuesFrom`), and the values. */
  valuesFrom: string;
  values: ReadonlyMap<string, string>;
}): (store: SecretStore) => Promise<string | undefined> {
  const { host, label, agentDir, opts, answerer, api, modelAuth, modelKey, declaredSecrets, valuesFrom, values } =
    input;
  const source = valuesSource(values, valuesFrom, opts);
  return (store) =>
    provideSecrets({
      host: label,
      store,
      needs: secretNeeds(modelAuth, declaredSecrets, modelKey),
      known: [...declaredNames(modelAuth, declaredSecrets, modelKey), ...(api.served ? [API_KEY_VARIABLE] : [])],
      ...(source === undefined ? {} : { source }),
      ...(answerer.kind === "terminal" ? { asker: terminalAsker } : {}),
      commands: secretsCommands(host, agentDir, opts.config),
      say: (line) => {
        console.error(`[fastagent] note: ${line}`);
        if (answerer.kind === "ticket") answerer.step.person.afterwards(line);
      },
      inform: (line) => console.error(`[fastagent] note: ${line}`),
      ...(api.served ? { mint: [mintApiKey(answerer.kind === "terminal")] } : {}),
      onMinted: async (minted) => {
        console.error(
          `[fastagent] made ${Object.keys(minted).join(", ")} for the Agent API and set it on ${label}. It is shown once ` +
            `and kept nowhere here: copy it now, it is what \`fastagent invoke --url … --key\` and every Caller of the ` +
            `API call with`,
        );
        for (const [name, value] of Object.entries(minted)) console.error(`[fastagent]   ${name}=${value}`);
      },
    });
}
