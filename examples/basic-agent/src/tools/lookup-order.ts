import { defineTool } from "@fastagent-sh/fastagent";

const ORDERS: Record<string, { status: string; totalUsd: number; daysSinceDelivery?: number }> = {
  "ORD-9231": { status: "delivered", totalUsd: 89, daysSinceDelivery: 12 },
  "ORD-4410": { status: "delivered", totalUsd: 149, daysSinceDelivery: 45 },
  "ORD-7702": { status: "processing", totalUsd: 54 },
};

export default defineTool({
  name: "lookup_order",
  description: "Look up an order's current status, total amount, and delivery age by order ID.",
  parameters: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "Order identifier, e.g. ORD-9231" },
    },
    required: ["orderId"],
  } as const,
  execute: async ({ orderId }) => {
    const order = ORDERS[orderId.toUpperCase()];
    if (!order) return JSON.stringify({ found: false, orderId });
    return JSON.stringify({ found: true, orderId: orderId.toUpperCase(), ...order });
  },
});
