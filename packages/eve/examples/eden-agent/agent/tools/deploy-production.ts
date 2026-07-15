import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

async function deployToProduction(version: string) {
  // Replace with the Eden-owned deployment integration used by this agent.
  return { deployed: version };
}

export default defineTool({
  description: "Deploy a version to production.",
  inputSchema: z.object({ version: z.string() }),
  approval: always(),
  async execute({ version }) {
    return deployToProduction(version);
  },
});
