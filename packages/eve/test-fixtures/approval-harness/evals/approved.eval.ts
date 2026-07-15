import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const parked = await t.send("Run the guarded operation.");
    parked.calledTool("guarded-operation", { status: "pending", count: 1 });
    t.requireInputRequest({ toolName: "guarded-operation", optionIds: ["approve", "deny"] });

    await t.respondAll("approve");

    t.succeeded();
    t.calledTool("guarded-operation", {
      status: "completed",
      count: 1,
      output: { executions: 1, release: "v1" },
    });
  },
});
