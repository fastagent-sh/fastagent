/** A value file as a deployment's store: Docker's (Compose reads it by `env_file:`), and what `start` reads. */
import { loadEnvValues, writeValues } from "../value-file.ts";
import type { SecretStore } from "./secret-store.ts";

export function fileStore(agentDir: string, file: string): SecretStore {
  return {
    async exists() {
      return true;
    },
    async ensure() {},
    async names() {
      return new Set([...loadEnvValues(file)].filter(([, value]) => value.trim() !== "").map(([name]) => name));
    },
    async write(values) {
      const names = Object.keys(values);
      await writeValues(
        agentDir,
        "deployment",
        names.map((name) => ({ name, value: values[name] as string })),
        names,
        file,
      );
    },
  };
}
