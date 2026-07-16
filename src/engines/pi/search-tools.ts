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

/** Activation cap per search: activation is additive, session-persisted, and has NO deactivate path —
 *  without a cap, one broad token ("get", "file") would permanently activate half the catalog and
 *  silently spend the entire deferral benefit for the rest of the conversation. Over the cap nothing
 *  activates; the model gets the candidates and narrows the query. */
const MAX_ACTIVATIONS_PER_SEARCH = 5;

/** Miss-path listing cap — same rationale as the activation cap: a typo query must not pour the whole
 *  catalog (the thing deferral keeps OUT of the context) back in as a tool result. */
const MAX_MISS_LISTING = 10;

/** Build the `search_tools` loader. Keyword search over the inactive tools' name+description. */
export function makeSearchToolsTool(): AgentTool {
  return defineTool({
    name: "search_tools",
    description:
      // First line short on purpose: the base prompt's tools list truncates at the first newline, and
      // the discovery guidance below would otherwise flood it (and duplicate its deferred note).
      "Discover and activate additional tools.\n" +
      "Part of this agent's toolset is inactive until needed: search by keywords (e.g. what you are " +
      "trying to do), and matching inactive tools are activated and become callable from that point on " +
      "(if too many match, you get the candidates back — narrow the query, or query an exact tool " +
      "name). ALWAYS search here before concluding a capability is missing.",
    input: z.object({
      query: z.string().min(1).describe("keywords describing the capability you need (e.g. 'weather forecast')"),
    }),
    async execute(input, ctx) {
      if (!ctx.tools) return "tool activation is unavailable outside a conversation turn.";
      // Search the WHOLE registered catalog: the loader is the only discovery surface, and in a long
      // conversation the model does not remember what it activated — a "No tools matched" answer for
      // an ALREADY-ACTIVE tool would push it toward the exact wrong conclusion (capability missing).
      // ponytail: naive keyword match (any query token as a case-insensitive substring of
      // name+description) with a hard per-search activation cap above — the two named ceilings are
      // relevance and irreversibility; swap in scoring/embeddings if catalogs outgrow this.
      const tokens = input.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      // AND semantics: EVERY token must hit — "adding a word narrows" must actually hold, or the
      // over-cap "narrow the query" instruction sends the model in circles (OR would widen with each
      // word, and a shared prefix like "fetch" could make a whole tool family permanently over-cap).
      const matchesQuery = (t: { name: string; description: string }) => {
        const haystack = `${t.name} ${t.description}`.toLowerCase();
        return tokens.every((token) => haystack.includes(token));
      };
      const describe = (t: { name: string; description: string }) => `${t.name} — ${t.description.split("\n")[0]}`;
      const active = new Set(ctx.tools.active());
      const registered = ctx.tools.registered();
      // Exact-name shortcut: the guaranteed escape hatch from the cap — a query that IS a registered
      // tool name addresses that one tool, no keyword scoring in the way.
      const exact = registered.find((t) => t.name.toLowerCase() === input.query.trim().toLowerCase());
      const activeMatches = registered.filter((t) => active.has(t.name) && (t === exact || matchesQuery(t)));
      const inactiveMatches = exact
        ? [exact].filter((t) => !active.has(t.name))
        : registered.filter((t) => !active.has(t.name) && matchesQuery(t));
      // Same listing cap as every other branch — a wide token can match most of the ACTIVE set too
      // (in chat that includes pi's default tools), and no answer may pour a catalog into the context.
      const listedActive = activeMatches.slice(0, MAX_MISS_LISTING);
      const moreActive = activeMatches.length - listedActive.length;
      const activeNote =
        activeMatches.length > 0
          ? `Already active (call directly): ${listedActive.map(describe).join("; ")}${moreActive > 0 ? ` … and ${moreActive} more` : ""}.`
          : "";
      if (inactiveMatches.length === 0) {
        if (activeNote) return activeNote;
        const inactive = registered.filter((t) => !active.has(t.name));
        if (inactive.length === 0) return "All tools are already active — nothing to discover.";
        // Cap the miss listing like the activation cap — both guard the same semantic (don't pour the
        // catalog back into the context the deferral exists to protect).
        const listed = inactive.slice(0, MAX_MISS_LISTING);
        const more = inactive.length - listed.length;
        return `No tools matched "${input.query}". Inactive tools: ${listed.map(describe).join("; ")}${more > 0 ? ` … and ${more} more — search with different keywords.` : ""}`;
      }
      if (inactiveMatches.length > MAX_ACTIVATIONS_PER_SEARCH) {
        // Same listing cap as the miss path — an over-cap answer must not pour the catalog into the
        // context either. Names alone suffice: the exact-name escape only needs a name to query.
        const listed = inactiveMatches.slice(0, MAX_MISS_LISTING);
        const more = inactiveMatches.length - listed.length;
        return `${inactiveMatches.length} inactive tools matched "${input.query}" — too many to activate at once (activation is permanent for this conversation). Narrow the query (or query an exact name). Matches: ${listed
          .map((t) => t.name)
          .join(", ")}${more > 0 ? ` … and ${more} more` : ""}.${activeNote ? ` ${activeNote}` : ""}`;
      }
      const activated = await ctx.tools.activate(inactiveMatches.map((t) => t.name));
      // Report what actually happened, not what was attempted: a parallel sibling call may have
      // activated the same matches first, leaving nothing new here — an empty "Activated:" would lie.
      if (activated.length === 0) {
        return `Matched ${inactiveMatches.map((t) => t.name).join(", ")} — already active (possibly activated by a concurrent call). Call them directly.${activeNote ? ` ${activeNote}` : ""}`;
      }
      const raced = inactiveMatches.filter((t) => !activated.includes(t.name));
      return `Activated: ${inactiveMatches
        .filter((t) => activated.includes(t.name))
        .map(describe)
        .join(
          "; ",
        )}.${raced.length > 0 ? ` Already active: ${raced.map((t) => t.name).join(", ")}.` : ""}${activeNote ? ` ${activeNote}` : ""} These tools are callable now.`;
    },
  });
}
