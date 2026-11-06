/**
 * A deploy's step that makes the target hold every value the deployment needs (secret-store.ts), written once for the
 * hosts that keep their values in a store of their own: who is asked is the deploy's answerer, and the file a source
 * reads is the production value file the deploy already loaded.
 */
import { confirm, isCancel, password } from "@clack/prompts";
import type { DeclaredSecret } from "../../../declared-secrets.ts";
import {
  type SecretAsker,
  type SecretCommands,
  type SecretStore,
  provideSecrets,
} from "../../../deploy/secret-store.ts";
import { type DeploymentApi, mintApiKey } from "../../../deploy/api.ts";
import { type ModelKey, declaredNames, secretNeeds } from "../../../deploy/secrets.ts";
import { API_KEY_VARIABLE } from "../../../http/server.ts";
import { unprotectedSecretsNote, writeValues } from "../../../value-file.ts";
import { displayPath } from "../../../paths.ts";
import { shellArg } from "../../shared.ts";
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
    set: (name) => `fastagent secrets set ${host} ${name}${rest}`,
  };
}

export function deploySecrets(input: {
  host: string;
  label: string;
  agentDir: string;
  opts: Pick<DeployOptions, "config">;
  answerer: Answerer;
  api: DeploymentApi;
  modelAuth: string | undefined;
  modelKey: ModelKey;
  declaredSecrets: readonly DeclaredSecret[];
  /** The production value file this deploy loaded, and its values. */
  valueFile: string;
  values: ReadonlyMap<string, string>;
}): (store: SecretStore) => Promise<string | undefined> {
  const { host, label, agentDir, opts, answerer, api, modelAuth, modelKey, declaredSecrets, valueFile, values } = input;
  return (store) =>
    provideSecrets({
      host: label,
      store,
      needs: secretNeeds(modelAuth, declaredSecrets, modelKey),
      known: [...declaredNames(modelAuth, declaredSecrets, modelKey), ...(api.served ? [API_KEY_VARIABLE] : [])],
      ...(values.size === 0 ? {} : { source: { file: valueFile, values } }),
      ...(answerer.kind === "terminal" ? { asker: terminalAsker } : {}),
      commands: secretsCommands(host, agentDir, opts.config),
      say: (line) => {
        console.error(`[fastagent] note: ${line}`);
        if (answerer.kind === "ticket") answerer.step.person.afterwards(line);
      },
      inform: (line) => console.error(`[fastagent] note: ${line}`),
      ...(api.served ? { mint: [mintApiKey()] } : {}),
      onMinted: async (minted) => {
        const names = Object.keys(minted);
        console.error(
          `[fastagent] made ${names.join(", ")} for the Agent API, set on ${label} and kept in ${valueFile}`,
        );
        const { unprotectedSecretsDir } = await writeValues(
          agentDir,
          "Agent API",
          names.map((name) => ({ name, value: minted[name] as string })),
          names,
        );
        if (unprotectedSecretsDir !== undefined)
          console.error(`[fastagent] note: ${unprotectedSecretsNote(unprotectedSecretsDir)}`);
      },
    });
}
