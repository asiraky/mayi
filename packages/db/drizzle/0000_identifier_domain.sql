CREATE DOMAIN "public"."mayi_id" AS varchar(12)
  CHECK (VALUE ~ '^[A-Za-z]{12}$');
