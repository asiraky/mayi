-- Backfill: every workspace OWNER's account email becomes a born-verified
-- default notification channel (destination + catch-all rule), matching what
-- signup now creates. Idempotent: owners whose workspace already has an EMAIL
-- destination for their address are skipped.
DO $$
DECLARE
  owner record;
  destination_id text;
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
BEGIN
  FOR owner IN
    SELECT m.workspace_id, m.user_id, lower(u.email) AS email
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.role = 'OWNER'
      AND m.active AND m.revoked_at IS NULL
      AND u.active AND u.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM forwarding_destinations d
        WHERE d.workspace_id = m.workspace_id
          AND d.type = 'EMAIL'
          AND lower(d.endpoint) = lower(u.email)
      )
  LOOP
    SELECT string_agg(substr(alphabet, 1 + floor(random() * 52)::int, 1), '')
      INTO destination_id
      FROM generate_series(1, 12);
    INSERT INTO forwarding_destinations (id, workspace_id, type, name, endpoint, mode, mapped_user_id, verified_at)
    VALUES (destination_id, owner.workspace_id, 'EMAIL', 'Account email', owner.email, 'notify_only', owner.user_id, now());
    INSERT INTO forwarding_rules (id, workspace_id, destination_id, action_kind)
    SELECT string_agg(substr(alphabet, 1 + floor(random() * 52)::int, 1), ''), owner.workspace_id, destination_id, '*'
      FROM generate_series(1, 12);
  END LOOP;
END $$;
