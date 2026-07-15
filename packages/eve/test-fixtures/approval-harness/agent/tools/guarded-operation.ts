import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

let executions = 0;

export default defineTool({
  description: "A deterministic side effect guarded by an approval.",
  inputSchema: z.object({ release: z.string() }),
  approval: always(),
  async execute({ release }) {
    executions += 1;
    return { executions, release };
  },
});
