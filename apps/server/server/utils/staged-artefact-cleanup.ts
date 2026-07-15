import type { ObjectStore } from "@mayi/storage";
import type { Sql } from "postgres";
import { database, objects } from "./runtime";

export type StagedArtefactCleanupDependencies = {
  sql?: Sql;
  objectStore?: ObjectStore;
  afterMarked?: (row: { id: string; objectKey: string }) => void | Promise<void>;
  afterObjectDeleted?: (row: { id: string; objectKey: string }) => void | Promise<void>;
};

/** Deletes up to `limit` expired, unclaimed request artefacts. Bound evidence is never selected. */
export async function cleanupExpiredStagedArtefacts(
  limit = 25,
  dependencies: StagedArtefactCleanupDependencies = {},
): Promise<number> {
  const sql = dependencies.sql ?? database().sql;
  const objectStore = dependencies.objectStore ?? objects();
  let cleaned = 0;
  for (; cleaned < limit; cleaned++) {
    const marked = await sql.begin(async (tx) => {
      const [row] = await tx`
        select id, object_key
        from artefacts
        where approval_id is null and request_key is not null
          and (state = 'DELETING' or (state in ('UPLOADING', 'READY') and expires_at <= now()))
        order by (state = 'DELETING') desc, expires_at
        for update skip locked
        limit 1
      `;
      if (!row) return undefined;
      const updated = await tx`
        update artefacts set state = 'DELETING'
        where id = ${row.id} and approval_id is null and request_key is not null
        returning id, object_key
      `;
      if (!updated[0]) return undefined;
      return { id: String(updated[0].id), objectKey: String(updated[0].object_key) };
    });
    if (!marked) break;

    await dependencies.afterMarked?.(marked);
    await objectStore.delete(marked.objectKey);
    await dependencies.afterObjectDeleted?.(marked);
    await sql`
      delete from artefacts
      where id = ${marked.id} and approval_id is null and request_key is not null and state = 'DELETING'
    `;
  }
  return cleaned;
}
