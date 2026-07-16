import { getCollection, type CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

/** Docs in navigation order. `introduction` is served at `/docs`; the rest at `/docs/<id>`. */
export async function orderedDocs(): Promise<DocEntry[]> {
  const entries = await getCollection("docs");
  return entries.sort((a, b) => a.data.order - b.data.order);
}

/** The site-relative path a doc renders at. */
export function docPath(entry: DocEntry): string {
  return entry.id === "introduction" ? "/docs" : `/docs/${entry.id}`;
}

/** One doc as standalone Markdown: a title, the description as a blockquote, then the body. */
export function docMarkdown(entry: DocEntry): string {
  return `# ${entry.data.title}\n\n> ${entry.data.description}\n\n${entry.body?.trim() ?? ""}\n`;
}
