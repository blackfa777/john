// Конфигурация Supabase для авторизации и синхронизации.
// Заполни двумя значениями из панели Supabase:
//   Project Settings → API → Project URL  и  Project API keys → anon public
// Это НЕ секретные ключи (они и так уходят в клиент), безопасность даёт RLS в базе.
//
// Пока здесь placeholder'ы (YOUR_...), приложение работает в ОФФЛАЙН-режиме,
// как раньше: без входа, данные только на устройстве. Как только впишешь
// реальные значения — включится экран входа/регистрации и облачная синхронизация.
window.SUPABASE_CONFIG = {
  url: "https://vipurfzfbtujglegscgx.supabase.co",       // напр. https://abcdefgh.supabase.co
  anonKey: "sb_publishable_xiPqWEimhzZCC4erUTmRdw_a8YtueHh"
};
