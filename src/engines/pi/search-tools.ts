/**
 * The built-in `search_tools` loader — the discovery surface for deferred tools (defineTool
 * `deferred: true`). A deferred tool's schema is not in the request and the model cannot see it; this
 * loader is how it finds and activates one. Mounted automatically (withSearchTool) only when a
 * deferred tool exists; a workspace tool named `search_tools` wins — the author owns the concept then
 * (same rule as the wake pair).
 */
import { z } from "zod";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { log } from "../../log.ts";
import { defineTool, isDeferredTool, stripDeferredMarker } from "./tool.ts";

/** Mount the built-in loader iff any mounted tool is deferred and the author didn't define their own. */
export function withSearchTool(tools: AgentTool[]): AgentTool[] {
  if (!tools.some(isDeferredTool)) return tools;
  const authored = tools.find((t) => t.name === "search_tools");
  if (authored) {
    if (!isDeferredTool(authored)) return tools;
    // A deferred LOADER is a contradiction — it is the only entry point to the deferred tools, so
    // nothing could ever activate it (or, through it, them): every deferred tool would be silently
    // unreachable. Ignore the marker and keep the loader active (fail visibly, keep the capability).
    log.warn(
      "[fastagent] search_tools is marked deferred — ignoring the marker: the loader must stay active, or no deferred tool could ever be activated",
    );
    return tools.map((t) => (t === authored ? stripDeferredMarker(t) : t));
  }
  return [...tools, makeSearchToolsTool()];
}

/** Build the `search_tools` loader. Keyword search over the inactive tools' name+description. */
export function makeSearchToolsTool(): AgentTool {
  return defineTool({
    name: "search_tools",
    description:
      "Discover and activate additional tools. Part of this agent's toolset is inactive until needed: " +
      "search by keywords (e.g. what you are trying to do), and matching tools are activated and become " +
      "callable from that point on. ALWAYS search here before concluding a capability is missing.",
    input: z.object({
      query: z.string().min(1).describe("keywords describing the capability you need (e.g. 'weather forecast')"),
    }),
    async execute(input, ctx) {
      if (!ctx.tools) return "tool activation is unavailable outside a conversation turn.";
      const active = new Set(ctx.tools.active());
      const inactive = ctx.tools.registered().filter((t) => !active.has(t.name));
      if (inactive.length === 0) return "All tools are already active — nothing to discover.";
      // ponytail: naive keyword match (any query token as a case-insensitive substring of
      // name+description); swap in scoring/embeddings if catalogs outgrow it.
      const tokens = input.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      const matches = inactive.filter((t) => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        return tokens.some((token) => haystack.includes(token));
      });
      if (matches.length === 0) {
        return `No tools matched "${input.query}". Inactive tools: ${inactive
          .map((t) => `${t.name} — ${t.description.split("\n")[0]}`)
          .join("; ")}`;
      }
      const activated = await ctx.tools.activate(matches.map((t) => t.name));
      // Report what actually happened, not what was attempted: a parallel sibling call may have
      // activated the same matches first, leaving nothing new here — an empty "Activated:" would lie.
      if (activated.length === 0) {
        return `Matched ${matches.map((t) => t.name).join(", ")} — already active (possibly activated by a concurrent call). Call them directly.`;
      }
      const alreadyActive = matches.filter((t) => !activated.includes(t.name));
      return `Activated: ${matches
        .filter((t) => activated.includes(t.name))
        .map((t) => `${t.name} — ${t.description.split("\n")[0]}`)
        .join(
          "; ",
        )}.${alreadyActive.length > 0 ? ` Already active: ${alreadyActive.map((t) => t.name).join(", ")}.` : ""} These tools are callable now.`;
    },
  });
}
