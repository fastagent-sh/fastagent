/**
 * `fastagent docker init`: write the portable container (`Dockerfile`, `.dockerignore`) into the agent
 * directory and print how to build and run it. A file the author owns is kept; `--force` regenerates only the ones
 * fastagent generated.
 */
import { resolve } from "node:path";
import { DOCKER_TARGET, STORAGE_DIR } from "../../deploy/container.ts";
import { displayPath } from "../../paths.ts";
import { writeContainer } from "../../platform.ts";
import { shellArg } from "../../shell-arg.ts";
import { agentDirOrExit, failStartup } from "../fail.ts";

export interface DockerInitOptions {
  force?: boolean;
}

export async function runDockerInit(dirArg: string, opts: DockerInitOptions): Promise<void> {
  const agentDir = agentDirOrExit(resolve(dirArg));
  const written = await writeContainer(agentDir, DOCKER_TARGET, { force: opts.force === true }).catch(failStartup);
  if (!written.ok) failStartup(new Error(`docker init stopped: ${written.gate}`));
  const { name, port } = written;
  // Docker refuses an image reference with an uppercase letter or a leading separator; container and volume names do not.
  const image = name.toLowerCase().replace(/^[_-]+/, "") || "agent";
  const context = displayPath(process.cwd(), agentDir) ?? ".";
  console.log(
    [
      `# Build the image, then run it with a volume at ${STORAGE_DIR} and the agent's values (its model key,`,
      `# FASTAGENT_API_KEY for the Agent API) from a file of your own.`,
      `docker build --pull -t ${image} ${shellArg(context)}`,
      `docker run -d --name ${name} --restart unless-stopped -v ${name}-data:${STORAGE_DIR} --env-file <file> ` +
        `-p ${port}:${port} ${image}`,
    ].join("\n"),
  );
}
