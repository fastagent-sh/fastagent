import { defineTool, sessionIdOf } from "@fastagent-sh/fastagent";

export default defineTool({
  name: "format_brief",
  description: "Format raw meeting or project notes into a structured summary with owners and next steps.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short brief title" },
      highlights: {
        type: "array",
        items: { type: "string" },
        description: "Key decisions or updates",
      },
      actionItems: {
        type: "array",
        items: { type: "string" },
        description: "Concrete follow-up tasks",
      },
    },
    required: ["title", "highlights"],
  } as const,
  execute: async ({ title, highlights, actionItems }, api, context) => {
    const sessionId = await sessionIdOf(api, context);
    const lines = [
      `# ${title}`,
      "",
      "## Highlights",
      ...highlights.map((item) => `- ${item}`),
      ...(actionItems && actionItems.length > 0
        ? ["", "## Action Items", ...actionItems.map((item) => `- [ ] ${item}`)]
        : []),
      ...(sessionId ? ["", `_Session: ${sessionId}_`] : []),
    ];
    return lines.join("\n");
  },
});
