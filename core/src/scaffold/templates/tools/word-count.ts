import { defineTool, z } from "@kid7st/fastagent";

// A code tool: filename (word-count.ts) is the tool name. tools/ is auto-discovered,
// so it needs no registration in fastagent.config. Test it directly with:
//   fastagent tool word-count '{"text":"hello there world"}'
export default defineTool({
  description: "Count the words and characters in a piece of text.",
  input: z.object({ text: z.string().describe("The text to measure") }),
  async execute({ text }) {
    const trimmed = text.trim();
    return { words: trimmed ? trimmed.split(/\s+/).length : 0, characters: text.length };
  },
});
