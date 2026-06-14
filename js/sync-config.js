// Конфиг синхронизации (этап 4b). Данные проекта Supabase.
// Оба значения ПУБЛИЧНЫЕ (ключ publishable, доступ защищён RLS + RPC-функциями) — можно в коде.
// НИКОГДА не вставляй сюда secret-ключ (sb_secret_… / service_role).
//
// Где взять: Supabase → проект → Settings → API:
//   SUPABASE_URL  = Project URL          (https://xxxx.supabase.co)
//   SUPABASE_ANON = publishable key      (sb_publishable_…)
//
// Пусто — синк выключен (приложение работает локально как обычно).

export const SUPABASE_URL = 'https://zyeekhsypncvosxfhbnm.supabase.co';
export const SUPABASE_ANON = 'sb_publishable_gvoGBsxLCglzp48NAsgB2w_-pEThW4K';
