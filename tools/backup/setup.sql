-- Выполнить владельцем БД. Существующие таблицы синхронизации не изменяются.
begin;
create schema if not exists backup_private;
revoke all on schema backup_private from public, anon, authenticated;
create table if not exists backup_private.access (
  singleton boolean primary key default true check (singleton),
  token_hash bytea not null check (octet_length(token_hash) = 32)
);
alter table backup_private.access enable row level security;
revoke all on backup_private.access from public, anon, authenticated;

create or replace function public.backup_export(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_token is null or length(p_token) <> 64 or not exists (
    select 1 from backup_private.access
    where token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
  ) then
    raise exception 'Backup access denied' using errcode = '42501';
  end if;
  -- Один SELECT даёт согласованный снимок всех строк без REST-пагинации.
  return (
    select jsonb_build_object(
      'format', 1,
      'count', count(*),
      'snapshots', coalesce(jsonb_agg(jsonb_build_object(
        'backup_id', encode(sha256(convert_to('nagruzka-backup:' || id, 'UTF8')), 'hex'),
        'salt', salt, 'blob', blob, 'version', version::text, 'updated_at', updated_at
      ) order by id), '[]'::jsonb)
    ) from public.sync_blobs
  );
end;
$$;
revoke all on function public.backup_export(text) from public, anon, authenticated, service_role;
grant execute on function public.backup_export(text) to anon;
commit;
