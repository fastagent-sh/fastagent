/**
 * Standard pattern for a custom domain tool (as used in production by real apps):
 * a plain TS module in your project implementing pi's `AgentTool` interface,
 * explicitly imported + injected by assembly code.
 * Code deploys with your project (and its deps); the standards-track for
 * declarative tool mounting is .mcp.json (MCP, future).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const lookupOrderTool: AgentTool = {
  name: "lookup_order",
  label: "Lookup order",
  description: "Look up an order by id (e.g. ORD-1234). Returns status and purchase date.",
  parameters: Type.Object({ orderId: Type.String({ description: "Order id like ORD-1234" }) }),
  async execute(_id, params) {
    const { orderId } = params as { orderId: string };
    // A real project queries its DB/API here; the demo uses fake data.
    const order = { orderId, status: "shipped", purchasedAt: "2026-05-20", item: "Pro plan (annual)" };
    return { content: [{ type: "text", text: JSON.stringify(order) }], details: order };
  },
};

export default lookupOrderTool;
