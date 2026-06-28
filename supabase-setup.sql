-- supabase-setup.sql — схема синхронизации «Нагрузки» (zero-knowledge).
--
-- Сервер хранит ТОЛЬКО шифротекст: id (256-битный локатор), salt (для Argon2, не
-- секрет), blob (iv+ciphertext). Расшифровать может лишь тот, у кого пароль + keyfile.
-- Доступ к таблицам — только через SECURITY DEFINER RPC (RLS включён, политик нет →
-- прямой select/insert ролью anon невозможен, перечислить чужие блобы нельзя).
--
-- РАЗДЕЛ A — то, что УЖЕ на проде (воспроизведено дословно из дампа функций
--            27.06.2026 + реконструкция DDL таблицы). На ЖИВОЙ базе РАДИ этого
--            раздела ничего запускать НЕ нужно. На ПУСТОМ новом проекте (DR —
--            смерть Supabase) выполнить файл целиком сверху вниз.
-- РАЗДЕЛ B — ШАГ 3 Phase 0: аддитивно, существующие объекты не трогает, безопасно
--            на живой базе. Именно его применяем сейчас.
--
-- Идемпотентно: create table if not exists / create or replace function.

-- ════════════════════════ РАЗДЕЛ A — уже на проде ════════════════════════

-- Таблица снимков. DDL РЕКОНСТРУИРОВАН по телам функций (дамп прислал только
-- функции). Для DR-пересборки этого достаточно; если нужна побайтовая копия
-- продовых ограничений — снять `information_schema.columns` по public.sync_blobs.
create table if not exists public.sync_blobs (
  id         text        primary key,
  salt       text        not null,
  blob       text        not null,
  version    bigint      not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.sync_blobs enable row level security;

-- Прочитать снимок по локатору.
create or replace function public.sync_pull(p_id text)
 returns table(salt text, blob text, version bigint, updated_at timestamp with time zone)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select salt, blob, version, updated_at from public.sync_blobs where id = p_id;
$function$;

-- Записать снимок с оптимистичной блокировкой по версии (last-write-wins по base).
create or replace function public.sync_push(p_id text, p_salt text, p_blob text, p_base_version bigint)
 returns table(ok boolean, version bigint, salt text, blob text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare cur public.sync_blobs%rowtype;
begin
  -- защита free-БД от спама: наши снимки крошечные (<100 КБ), 2 МБ — с запасом
  if length(p_blob) > 2000000 or length(p_salt) > 64 then
    raise exception 'blob too large';
  end if;

  select * into cur from public.sync_blobs where id = p_id for update;
  if not found then
    insert into public.sync_blobs(id, salt, blob, version) values (p_id, p_salt, p_blob, 1);
    return query select true, 1::bigint, p_salt, p_blob;
  elsif cur.version = p_base_version then
    update public.sync_blobs set blob = p_blob, salt = p_salt,
      version = cur.version + 1, updated_at = now() where id = p_id;
    return query select true, (cur.version + 1)::bigint, p_salt, p_blob;
  else
    return query select false, cur.version, cur.salt, cur.blob;
  end if;
end;
$function$;

-- ═══════════════════ РАЗДЕЛ B — ШАГ 3 (применить сейчас) ═══════════════════

-- B1. sync_restore — БЕЗУСЛОВНАЯ перезапись снимка, version = cur+1.
--     Нужна для отката поверх ЖИВОГО сервера (DR/time-travel): обычный sync_push
--     с оптимистичной версией старое поверх нового не пустит, а тут мы намеренно
--     ставим прошлый шифроблоб как новый HEAD. Это «сырой» примитив (curl).
--     UI-путь восстановления его НЕ использует (приложение применяет .nz локально
--     и пушит как новую версию обычным sync_push).
--     Тот же id-контракт, что у sync_pull/push → на Шаге 4 работает и по id чанка.
create or replace function public.sync_restore(p_id text, p_salt text, p_blob text)
 returns table(ok boolean, version bigint)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare cur public.sync_blobs%rowtype;
begin
  if length(p_blob) > 2000000 or length(p_salt) > 64 then
    raise exception 'blob too large';
  end if;

  select * into cur from public.sync_blobs where id = p_id for update;
  if not found then
    insert into public.sync_blobs(id, salt, blob, version) values (p_id, p_salt, p_blob, 1);
    return query select true, 1::bigint;
  else
    update public.sync_blobs set blob = p_blob, salt = p_salt,
      version = cur.version + 1, updated_at = now() where id = p_id;
    return query select true, (cur.version + 1)::bigint;
  end if;
end;
$function$;

-- B2. Account-мета: ОДНА соль Argon2 на аккаунт (задел под чанки, Шаг 4).
--     Сейчас соль лежит внутри единственного блоба. На Шаге 4 блобов (чанков)
--     станет много, и свежему устройству надо узнать соль ДО загрузки первого
--     чанка → храним её отдельной строкой. До Шага 4 эта таблица «спит».
--     Ключ p_id — клиентский локатор меты (на Шаге 4: base64url(SHA-256(SyncID‖"meta"))),
--     соль НЕ секрет. Таблица за SECURITY DEFINER, как sync_blobs.
create table if not exists public.sync_meta (
  id         text        primary key,
  salt       text        not null,
  created_at timestamptz not null default now()
);
alter table public.sync_meta enable row level security;

-- Прочитать соль аккаунта (null, если ещё не задана).
create or replace function public.sync_meta_get(p_id text)
 returns text
 language sql
 security definer
 set search_path to 'public'
as $function$
  select salt from public.sync_meta where id = p_id;
$function$;

-- Задать соль ОДИН раз (insert-once). Возвращает фактически хранимую соль: если
-- строка уже есть — отдаёт существующую и НЕ перезаписывает. Так первый
-- победитель фиксирует соль навсегда (смена соли осиротила бы все чанки), а гонка
-- двух «первых» устройств сходится к одному значению.
create or replace function public.sync_meta_init(p_id text, p_salt text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare existing text;
begin
  if length(p_salt) > 64 then
    raise exception 'salt too large';
  end if;
  insert into public.sync_meta(id, salt) values (p_id, p_salt)
    on conflict (id) do nothing;
  select salt into existing from public.sync_meta where id = p_id;
  return existing;
end;
$function$;

-- Доступ ролям клиента (по умолчанию CREATE FUNCTION и так грантит PUBLIC; явно —
-- для самодокументированности и на случай ужесточённого дефолта).
grant execute on function public.sync_restore(text, text, text)  to anon, authenticated;
grant execute on function public.sync_meta_get(text)             to anon, authenticated;
grant execute on function public.sync_meta_init(text, text)      to anon, authenticated;
