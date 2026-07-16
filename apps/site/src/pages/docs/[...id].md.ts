import type { APIRoute, GetStaticPaths } from "astro";
import { docMarkdown, orderedDocs, type DocEntry } from "../../lib/docs";

// Clean-Markdown twin of each /docs/<id> page (URL + `.md`), per the llms.txt convention.
// `introduction` renders at /docs.md instead (see ../docs.md.ts).
export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await orderedDocs();
  return entries
    .filter((entry) => entry.id !== "introduction")
    .map((entry) => ({ params: { id: entry.id }, props: { entry } }));
};

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: DocEntry };
  return new Response(docMarkdown(entry), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
