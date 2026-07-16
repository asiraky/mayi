import type { APIRoute } from "astro";
import { docPath, orderedDocs } from "../lib/docs";

// The llms.txt convention (https://llmstxt.org): a Markdown index an LLM reads instead
// of crawling HTML. Links point at the `.md` twin of each page so a client fetches clean
// Markdown, and to /llms-full.txt for the whole corpus in one request.
export const GET: APIRoute = async ({ site }) => {
  const base = site?.origin ?? "https://mayi.sh";
  const docs = await orderedDocs();

  const lines = [
    "# May I?",
    "",
    "> An approval service for software agents. An agent describes an exact action, a person approves or denies it, and the service issues a signed receipt the executor verifies before it acts.",
    "",
    "May I? ships a TypeScript SDK, `@mayiapp/sdk`, for requesting approvals and verifying the resulting receipts and webhooks. The pages below are the canonical documentation.",
    "",
    "## Docs",
    "",
    ...docs.map((entry) => `- [${entry.data.title}](${base}${docPath(entry)}.md): ${entry.data.description}`),
    "",
    "## Full text",
    "",
    `- [All documentation, concatenated](${base}/llms-full.txt)`,
    "",
    "## Optional",
    "",
    `- [Source and issues](https://github.com/asiraky/mayi)`,
    `- [SDK on npm](https://www.npmjs.com/package/@mayiapp/sdk)`,
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
