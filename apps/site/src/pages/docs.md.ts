import type { APIRoute } from "astro";
import { docMarkdown, orderedDocs } from "../lib/docs";

// Clean-Markdown twin of the /docs landing page (the `introduction` doc).
export const GET: APIRoute = async () => {
  const entry = (await orderedDocs()).find((item) => item.id === "introduction");
  if (!entry) throw new Error("Missing introduction documentation");
  return new Response(docMarkdown(entry), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
