// Configuração do Supabase (Project Settings › API Keys).
// A chave PUBLICÁVEL (sb_publishable_... ou "anon") é pública por natureza: quem protege os dados
// são as regras de segurança (RLS) do banco, em supabase/schema.sql.
// NUNCA coloque aqui a chave secreta (sb_secret_... ou service_role) — o app se recusa a funcionar com ela.
export const SUPABASE_URL = 'https://rxjstaddquvatdijegyt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable__rhnfwolyucZSYtTZFR9jw_XBHqQLSD';
