/**
 * github-reviewer composition root (the one place that knows all of N/M/K).
 *
 *   M — the built agent: createPiAgentFromArtifact (model/skills/tools frozen by `fastagent build`)
 *   N — the webhook channel: createWebhookHandler + the GitHub binding
 *   K — execution lifetime: createTrackedBackground (single-instance; fly.io runs a long-lived VM)
 *
 * It runs from a built artifact (.fastagent/build); sessions live OUTSIDE it (so a redeploy never
 * wipes conversations). Two routes: GET /health (fly.io checks) and POST /webhook (GitHub).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPiAgentFromArtifact,
  createTrackedBackground,
  createWebhookHandler,
  nodeListener,
} from "@kid7st/fastagent";
import { githubBinding } from "./github-binding.ts";

if (!process.env.GITHUB_WEBHOOK_SECRET) {
  // Fail at startup, not on the first webhook: a reviewer with no secret would 400 every delivery.
  console.error("[github-reviewer] GITHUB_WEBHOOK_SECRET is not set; refusing to start");
  process.exit(1);
}

// OAuth in a container: pi's default resolver reads ~/.pi/agent/auth.json. Inject that file's
// content as a secret (`fly secrets set PI_AUTH_JSON="$(cat ~/.pi/agent/auth.json)"`) and
// materialize it here, so an OAuth-only model (e.g. openai-codex) works without an API key. No
// refresh today (core-design §10.5): an expired token needs the secret re-set.
if (process.env.PI_AUTH_JSON) {
  const dir = join(homedir(), ".pi", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), process.env.PI_AUTH_JSON);
}

const artifactDir = process.env.FASTAGENT_ARTIFACT ?? ".fastagent/build";
const port = Number(process.env.PORT ?? 8080);

const { agent, modelSpec } = await createPiAgentFromArtifact(artifactDir);
const { background, drain } = createTrackedBackground();
const webhook = createWebhookHandler(agent, githubBinding, background);

const server = createServer(
  nodeListener(async (req) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return new Response("ok\n");
    if (pathname === "/webhook") return webhook(req);
    return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  }),
);

server.listen(port, () =>
  console.error(`[github-reviewer] model=${modelSpec} listening on :${port} (POST /webhook)`),
);

// Graceful shutdown: stop accepting, let in-flight requests enqueue their review, then drain the
// background reviews before exiting — close BEFORE drain so no late request escapes the snapshot.
process.on("SIGTERM", async () => {
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await drain();
  process.exit(0);
});
