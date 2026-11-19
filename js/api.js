// Cliente Supabase + mensagens de erro em português.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/** Recusa chaves secretas: elas ignoram o RLS e não podem ir para o navegador. */
function isSecretKey(k) {
  if (k.startsWith('sb_secret_')) return true;
  try {
    return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role';
  } catch {
    return false;
  }
}
export const secretKeyError = isSecretKey(SUPABASE_ANON_KEY);
export const configured = !secretKeyError
  && /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 40;

export const sb = configured
  ? createClient(SUPABASE_URL.replace(/\/$/, ''), SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  })
  : null;

const AUTH_MSG = [
  [/invalid login credentials/i, 'E-mail ou senha incorretos.'],
  [/email not confirmed/i, 'Confirme seu e-mail antes de entrar (procure a mensagem na caixa de entrada e no spam).'],
  [/user already registered/i, 'Não foi possível criar a conta com esse e-mail. Se já tem cadastro, use “Entrar” ou “Esqueci minha senha”.'],
  [/password should|password is too short|at least \d+ characters/i, 'A senha não atende aos requisitos (mínimo 10 caracteres, com letras e números).'],
  [/weak|pwned|easy to guess/i, 'Essa senha é fraca ou já apareceu em vazamentos. Escolha outra.'],
  [/signups not allowed|signup is disabled/i, 'O cadastro está fechado. Peça ao administrador para liberar seu acesso.'],
  [/rate limit|too many|over_email_send_rate_limit/i, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'],
  [/same_password|should be different/i, 'A nova senha precisa ser diferente da atual.'],
  [/reauthentication|recent login/i, 'Por segurança, saia e entre de novo antes de trocar a senha.'],
  [/failed to fetch|networkerror|load failed/i, 'Sem conexão com o servidor. Verifique a internet e tente de novo.'],
  [/jwt expired|invalid jwt|not_authenticated/i, 'Sua sessão expirou. Entre novamente.'],
];
const DB_MSG = {
  goals_over_100: 'A soma dos objetivos não pode passar de 100% da renda.',
  need_one_admin: 'A casa precisa de pelo menos um administrador com login.',
  invalid_invite: 'Código de convite inválido ou expirado.',
  already_member: 'Você já faz parte dessa casa.',
  too_many_attempts: 'Muitas tentativas de convite. Aguarde uma hora.',
  too_many_houses: 'Limite de 10 casas por conta.',
  resident_has_login: 'Esse morador já tem login.',
  categories_house_name_key: 'Já existe uma categoria com esse nome.',
  forbidden: 'Você não tem permissão para esta ação.',
};

export function friendly(err) {
  const raw = String(err?.message ?? err ?? 'Erro desconhecido');
  for (const [re, msg] of AUTH_MSG) if (re.test(raw)) return Object.assign(new Error(msg), { cause: err });
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`;
  for (const [k, msg] of Object.entries(DB_MSG)) if (text.includes(k)) return new Error(msg);
  if (err?.code === '23505') return new Error('Já existe um registro com esses dados.');
  if (err?.code === '23514') return new Error('Algum campo está fora do permitido. Revise os dados.');
  if (err?.code === '42501' || /row-level security|permission denied/i.test(raw)) return new Error('Você não tem permissão para esta ação.');
  if (err?.code === '23503') return new Error('Registro ligado a outro cadastro inválido.');
  // update/delete que o RLS filtrou: nenhuma linha visível para alterar
  if (err?.code === 'PGRST116') return new Error('Registro não encontrado ou sem permissão para alterá-lo.');
  return err instanceof Error ? err : new Error(raw);
}

/** Executa uma chamada Supabase e devolve data, ou lança um erro amigável. */
export async function q(promise) {
  const { data, error } = await promise;
  if (error) throw friendly(error);
  return data;
}

/** Chama a Edge Function "ai" e devolve o JSON, com a mensagem de erro dela quando houver. */
export async function callAi(body) {
  const { data, error } = await sb.functions.invoke('ai', { body });
  if (error) {
    let msg = 'Não foi possível falar com o assistente de IA.';
    try {
      const j = await error.context?.json?.();
      if (j?.error) msg = j.error;
    } catch { /* sem corpo */ }
    if (/failed to send|fetch/i.test(String(error.message)) && msg.startsWith('Não foi')) {
      msg = 'A função de IA não respondeu. Ela foi publicada no Supabase? (veja o README)';
    }
    throw new Error(msg);
  }
  return data;
}
