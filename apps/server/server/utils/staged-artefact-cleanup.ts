import { database, objects } from "./runtime";

/** Deletes up to `limit` expired, unclaimed request artefacts. Bound evidence is never selected. */
export async function cleanupExpiredStagedArtefacts(limit = 25): Promise<number> {
  let cleaned = 0;
  for (; cleaned < limit; cleaned++) {
    const removed = await database().sql.begin(async (sql) => {
      const [row] = await sql`
        select id, object_key
        from artefacts
        where approval_id is null and request_key is not null and expires_at <= now()
        order by expires_at
        for update skip locked
        limit 1
      `;
      if (!row) return false;
      await objects().delete(String(row.object_key));
      await sql`delete from artefacts where id = ${row.id} and approval_id is null`;
      return true;
    });
    if (!removed) break;
  }
  return cleaned;
}
