import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const parked = await t.send("Run the guarded operation.");
    parked.calledTool("guarded-operation", { status: "pending", count: 1 });
    t.requireInputRequest({ toolName: "guarded-operation", optionIds: ["approve", "deny"] });

    await t.respondAll("deny");

    t.succeeded();
    t.calledTool("guarded-operation", { status: "rejected", count: 1 });
    t.calledTool("guarded-operation", { status: "completed", count: 0 });
  },
});
