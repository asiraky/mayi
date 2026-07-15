import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  modelContextWindowTokens: 100_000,
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "guarded-operation", input: { release: "v1" } }] };
    }
    return toolResults[0]?.isError ? "The guarded operation was denied." : "The guarded operation completed.";
  }),
});
