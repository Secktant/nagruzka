-- Запустить один раз после setup.sql, затем только для ротации доступа.
-- Скопировать результат прямо в GitHub Secret BACKUP_TOKEN.
-- Повторный запуск заменяет прежний токен. В таблице хранится только SHA-256.
with secret as materialized (
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') as token
), saved as (
  insert into backup_private.access(singleton, token_hash)
  select true, sha256(convert_to(token, 'UTF8')) from secret
  on conflict (singleton) do update set token_hash = excluded.token_hash
  returning singleton
)
select token as backup_token from secret cross join saved;
