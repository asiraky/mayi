import type { APIRoute } from "astro";
import { docMarkdown, orderedDocs } from "../lib/docs";

// The whole documentation corpus as one Markdown file, in navigation order, so an agent
// can ingest it in a single fetch. Companion to /llms.txt.
export const GET: APIRoute = async () => {
  const docs = await orderedDocs();
  const body = [
    "# May I? — documentation",
    "",
    "> Full text of every documentation page, in order. Index: /llms.txt",
    "",
    ...docs.map((entry) => docMarkdown(entry)),
  ].join("\n---\n\n");

  return new Response(`${body}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
