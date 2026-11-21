// Assistente de IA (Claude, compatíveis com OpenAI, Gemini) via Edge Function.
import { callAi } from '../api.js';
import { state, page, card, isAdmin, field, input, select, run, reload } from '../ctx.js';
import { monthSummary, buildContext } from '../finance.js';
import { h, clear, monthLabel, confirmDialog, brl } from '../ui.js';
import { icon } from '../icons.js';

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'Compatível com OpenAI (OpenAI, OpenRouter, Groq, DeepSeek...)', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
};

const SUGGESTIONS = ['Onde estou gastando mais este mês?', 'Consigo cumprir minhas metas no prazo?', 'Quais categorias passaram do orçamento?', 'Quanto posso cortar em lazer?'];

export async function renderAI() {
  const settings = state.d.ai;
  const admin = isAdmin();

  let config = null;
  if (admin) {
    const prov = select('provider', Object.entries(PROVIDERS).map(([k, p]) => ({ value: k, label: p.label })), settings?.provider ?? 'anthropic');
    const model = input('model', { maxlength: 100, value: settings?.model ?? PROVIDERS.anthropic.defaultModel });
    const baseUrl = input('baseUrl', { maxlength: 300, value: settings?.base_url ?? PROVIDERS.openai.defaultBaseUrl });
    const key = input('apiKey', {
      type: 'password', autocomplete: 'off', maxlength: 500,
      placeholder: settings?.key_hint ? `salva (termina em …${settings.key_hint}) — deixe vazio para manter` : 'cole a chave de API',
    });
    const baseField = field('URL base (API compatível com OpenAI)', baseUrl, { cls: 'span-2' });
    prov.addEventListener('change', () => {
      baseField.hidden = prov.value !== 'openai';
      model.value = settings?.provider === prov.value ? settings.model : PROVIDERS[prov.value].defaultModel;
    });
    baseField.hidden = prov.value !== 'openai';
    const save = h('button', { class: 'btn', type: 'submit' }, icon('check', 18), h('span', {}, 'Salvar configuração'));
    const form = h('form', { class: 'form-grid', autocomplete: 'off' }, field('Provedor', prov), field('Modelo', model), baseField, field('Chave de API', key, { cls: 'span-2' }),
      h('div', { class: 'dialog-actions span-2' },
        settings ? h('button', {
          type: 'button', class: 'btn ghost danger-text',
          onclick: async (ev) => {
            if (!await confirmDialog('Remover a configuração e a chave de IA?', { danger: true, confirmText: 'Remover' })) return;
            if (await run(ev.currentTarget, () => callAi({ action: 'delete', houseId: state.houseId }), 'Configuração removida.')) await reload();
          },
        }, 'Remover configuração') : null, save));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ok = await run(save, () => callAi({ action: 'save', houseId: state.houseId, provider: prov.value, model: model.value, baseUrl: baseUrl.value, apiKey: key.value }), 'Configuração salva.');
      if (ok) await reload();
    });
    config = card('Conexão com a IA', { sub: 'Somente administradores', cls: 'ai-config' }, form,
      h('p', { class: 'hint' }, icon('lock', 14), ' A chave vai direto para a função segura do Supabase, é criptografada (AES-256-GCM) e nunca volta para o navegador.'));
  }

  const chatBox = h('div', { class: 'chat', 'aria-live': 'polite' });
  const qText = h('textarea', { name: 'q', maxlength: 4000, required: true, rows: 2, placeholder: `Pergunte sobre ${monthLabel(state.month)}…`, 'aria-label': 'Pergunta' });
  const paint = () => {
    clear(chatBox);
    if (!state.chat.length) {
      chatBox.append(h('div', { class: 'chat-empty' }, h('span', { class: 'kpi-ico' }, icon('sparkles', 22)),
        h('strong', {}, 'Como posso ajudar com as finanças?'),
        h('div', { class: 'chips' }, ...SUGGESTIONS.map((s) => h('button', {
          type: 'button', class: 'chip',
          onclick: () => {
            qText.value = s;
            chatForm.requestSubmit();
          },
        }, s)))));
    }
    for (const m of state.chat) chatBox.append(h('div', { class: `msg ${m.role}` }, m.content));
    chatBox.scrollTop = chatBox.scrollHeight;
  };
  const send = h('button', { class: 'btn', type: 'submit', 'aria-label': 'Enviar' }, icon('send', 18));
  const reset = h('button', { class: 'btn ghost small', type: 'button', onclick: () => { state.chat = []; paint(); } }, 'Nova conversa');
  const chatForm = h('form', { class: 'chat-form' }, qText, send);
  paint();
  qText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = qText.value.trim();
    if (!text) return;
    state.chat.push({ role: 'user', content: text });
    if (state.chat.length > 19) state.chat = state.chat.slice(-19);
    while (state.chat[0]?.role !== 'user') state.chat.shift();
    qText.value = '';
    paint();
    const thinking = h('div', { class: 'msg assistant muted typing' }, 'Analisando suas finanças…');
    chatBox.append(thinking);
    const out = await run(send, async () => {
      const context = buildContext(state.d.house.name, monthSummary(state.d, state.month), brl);
      return callAi({ action: 'chat', houseId: state.houseId, context, messages: state.chat });
    });
    thinking.remove();
    if (out?.answer) state.chat.push({ role: 'assistant', content: out.answer });
    else state.chat.pop();
    paint();
  });

  page('Assistente de IA', { subtitle: settings ? `${PROVIDERS[settings.provider]?.label ?? settings.provider} · ${settings.model}` : 'Análise das finanças com inteligência artificial' },
    h('div', { class: 'ai-layout' },
      card('Conversa', { actions: settings ? reset : null, cls: 'chat-card' },
        settings ? h('div', { class: 'stack' }, chatBox, chatForm,
          h('p', { class: 'hint' }, 'Ao perguntar, o resumo financeiro do mês (nomes, entradas, saídas, categorias, objetivos) vai para o provedor de IA. E-mails e senhas nunca são enviados.'))
          : h('p', { class: 'muted' }, admin ? 'Configure a conexão ao lado para começar.' : 'Peça ao administrador para configurar a IA.')),
      config));
}
