import { defineTool, needs, sessionIdOf } from "@fastagent-sh/fastagent";

export default needs(
  [
    { name: "TENANT_ID", description: "Tenant owning this embedded instance" },
    { name: "APP_API_BASE", description: "Internal app API base URL", optional: true },
    { name: "APP_API_TOKEN", description: "Scoped internal service token", optional: true },
  ],
  ({ TENANT_ID, APP_API_BASE, APP_API_TOKEN }) =>
    defineTool({
      name: "get_workspace_metrics",
      description: "Fetch current usage, seat count, and plan limits for the authenticated tenant workspace.",
      parameters: {
        type: "object",
        properties: {
          windowDays: { type: "integer", minimum: 1, maximum: 90, description: "Lookback window in days (default: 7)" },
        },
      } as const,
      execute: async ({ windowDays }, api, context) => {
        const days = windowDays ?? 7;
        const sessionId = await sessionIdOf(api, context);

        // When wired to your real backend API, forward the tenant-scoped token and session correlation id.
        if (APP_API_BASE && APP_API_TOKEN) {
          const res = await fetch(`${APP_API_BASE}/internal/tenants/${encodeURIComponent(TENANT_ID)}/metrics?days=${days}`, {
            headers: {
              authorization: `Bearer ${APP_API_TOKEN}`,
              ...(sessionId ? { "x-fastagent-session": sessionId } : {}),
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) return JSON.stringify({ error: `Internal API returned HTTP ${res.status}` });
          return await res.text();
        }

        // Fallback sample payload for trying the example locally without an external backend.
        return JSON.stringify({
          tenantId: TENANT_ID,
          sessionId,
          windowDays: days,
          plan: "Pro",
          activeSeats: 18,
          seatLimit: 25,
          apiRequestsUsed: 412_900,
          apiRequestLimit: 500_000,
        });
      },
    }),
);
