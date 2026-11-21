// Lançamento por voz com IA.
// O reconhecimento de fala é o do próprio navegador (Web Speech API): o áudio NUNCA é gravado nem enviado
// ao nosso servidor — só o texto reconhecido vai para a IA, que devolve lançamentos para o usuário revisar.
import { sb, q, callAi } from '../api.js';
import { state, houseRow, run, reload, categoryChip, accountName, residentName, isAdmin } from '../ctx.js';
import { localToday } from '../finance.js';
import { quickParse } from '../quickparse.js';
import { h, openDialog, brl, dateShort, toast } from '../ui.js';
import { icon } from '../icons.js';
import { openTxDialog } from './tx.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

const EXAMPLES = [
  'Gastei 52 e 90 no mercado hoje no Nubank',
  'Recebi 1.800 do freela ontem',
  'Paguei 120 de luz e 89 de internet',
];

export function openVoiceDialog() {
  const today = localToday();
  let rec = null;
  let listening = false;
  let finalText = '';
  let items = [];
  let note = '';

  const body = h('div', { class: 'voice' });
  const dlg = openDialog({
    title: 'Lançar por voz', body, wide: true,
    onClose: () => stop(true),          // descarta qualquer reconhecimento em andamento
  });

  // ------------------------------------------------------------ etapa 1: falar / digitar
  const status = h('p', { class: 'voice-status', 'aria-live': 'polite' });
  const text = h('textarea', { rows: 3, maxlength: 1000, class: 'voice-text', placeholder: 'O que você disser aparece aqui. Você também pode digitar ou corrigir.', 'aria-label': 'Texto do lançamento' });
  const mic = h('button', { type: 'button', class: 'mic', 'aria-label': 'Começar a falar' }, icon('mic', 34));
  const go = h('button', { type: 'button', class: 'btn' }, icon('sparkles', 18), h('span', {}, 'Interpretar'));

  function setListening(on) {
    listening = on;
    mic.classList.toggle('on', on);
    mic.setAttribute('aria-label', on ? 'Parar' : 'Começar a falar');
    mic.replaceChildren(icon(on ? 'stop' : 'mic', 34));
    status.textContent = on ? 'Ouvindo… fale o lançamento. Toque de novo para terminar.' : (voiceSupported ? 'Toque no microfone e fale.' : '');
  }

  function stop(discard = false) {
    if (!rec) return;
    const r = rec;
    rec = null;
    if (discard) {
      r.onresult = null;
      r.onend = null;
      r.abort();
    } else r.stop();
  }

  function start() {
    if (!SR) return;
    finalText = text.value.trim() ? `${text.value.trim()} ` : '';
    rec = new SR();
    rec.lang = 'pt-BR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += `${t.trim()} `;
        else interim += t;
      }
      text.value = (finalText + interim).trim();
    };
    rec.onerror = (e) => {
      const msg = {
        'not-allowed': 'O navegador bloqueou o microfone. Libere o acesso no ícone de cadeado da barra de endereço, ou digite.',
        'service-not-allowed': 'O reconhecimento de voz está bloqueado neste navegador. Digite o lançamento.',
        'no-speech': 'Não ouvi nada. Toque no microfone e tente de novo.',
        'audio-capture': 'Nenhum microfone encontrado. Digite o lançamento.',
        network: 'Sem conexão com o serviço de voz do navegador. Digite o lançamento.',
      }[e.error];
      if (msg) toast(msg, true);
    };
    rec.onend = () => {
      const wasListening = listening;
      rec = null;
      setListening(false);
      // Terminou de falar: já interpreta (o áudio já foi descartado pelo navegador)
      if (wasListening && text.value.trim().length >= 3) interpret();
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }

  mic.addEventListener('click', () => (listening ? stop() : start()));
  go.addEventListener('click', () => {
    stop(true);
    setListening(false);
    interpret();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      go.click();
    }
  });

  function paintInput() {
    body.replaceChildren(
      h('div', { class: 'voice-stage' },
        voiceSupported ? mic : h('div', { class: 'empty-ico' }, icon('sparkles', 26)),
        status,
        h('div', { class: 'chips center-chips' }, ...EXAMPLES.map((ex) => h('button', {
          type: 'button', class: 'chip',
          onclick: () => {
            stop(true);
            setListening(false);
            text.value = ex;
            text.focus();
          },
        }, `“${ex}”`)))),
      text,
      h('p', { class: 'hint' }, icon('lock', 14), voiceSupported
        ? ' O áudio não é gravado nem guardado: o navegador converte a fala em texto (no Chrome, pelo serviço de voz do Google) e só o texto é enviado à IA.'
        : ' Este navegador não reconhece voz. Digite o lançamento (no Chrome, Edge e Safari dá para falar).'),
      h('div', { class: 'dialog-actions' }, go));
    if (!voiceSupported) status.textContent = '';
  }

  // ------------------------------------------------------------ etapa 2: IA
  async function interpret() {
    const said = text.value.trim();
    if (said.length < 3) return toast('Fale ou digite o lançamento primeiro.', true);
    if (!state.d.ai) return fallback(said, isAdmin()
      ? 'A IA ainda não está configurada (Assistente IA). Preenchi o que deu para entender; confira e salve.'
      : 'A IA não está configurada nesta casa. Preenchi o que deu para entender; confira e salve.');
    body.replaceChildren(h('div', { class: 'voice-stage' }, h('span', { class: 'spinner lg' }), h('p', { class: 'voice-status' }, 'Entendendo o lançamento…'),
      h('blockquote', { class: 'voice-quote' }, said)));
    try {
      const out = await callAi({ action: 'parse', houseId: state.houseId, text: said, today });
      items = (out.items ?? []).map((x, i) => ({ ...x, key: i }));
      note = out.note ?? '';
      if (!items.length) {
        paintInput();
        text.value = said;
        status.textContent = note || 'Não encontrei um valor na frase. Tente dizer, por exemplo: “gastei 50 reais no mercado”.';
        return;
      }
      paintReview(said);
    } catch (e) {
      fallback(said, `${e.message} Preenchi o que deu para entender; confira e salve.`);
    }
  }

  function fallback(said, msg) {
    const guess = quickParse(said, today);
    dlg.close();
    toast(msg, true);
    openTxDialog({ ...guess, amount_cents: guess.amount_cents ?? 0 }, { copy: true, date: guess.date });
    if (!guess.amount_cents) setTimeout(() => document.querySelector('dialog[open] input[name=amount]')?.select(), 50);
  }

  // ------------------------------------------------------------ etapa 3: revisar e salvar
  function paintReview(said) {
    const save = h('button', { type: 'button', class: 'btn' }, icon('check', 18), h('span', {}, items.length > 1 ? `Salvar ${items.length} lançamentos` : 'Salvar lançamento'));
    const list = h('ul', { class: 'voice-items' }, ...items.map((it) => {
      const isIn = it.type === 'income';
      return h('li', { class: 'voice-item' },
        h('span', { class: `mv-ico ${isIn ? 'in' : 'out'}` }, icon(isIn ? 'arrow_in' : 'arrow_out', 18)),
        h('div', { class: 'vi-main' },
          h('div', { class: 'vi-top' }, h('strong', {}, it.description), h('strong', { class: `num ${isIn ? 'pos' : 'neg'}` }, `${isIn ? '+' : '−'} ${brl(it.amount_cents)}`)),
          h('div', { class: 'vi-meta' },
            h('span', {}, icon('calendar', 13), dateShort(it.date)), categoryChip(it.category_id),
            h('span', {}, icon('bank', 13), accountName(it.account_id)), h('span', {}, icon('user', 13), residentName(it.resident_id)))),
        h('div', { class: 'vi-actions' },
          h('button', {
            type: 'button', class: 'icon-btn sm', title: 'Editar', 'aria-label': `Editar ${it.description}`,
            onclick: () => openTxDialog(it, {
              copy: true, date: it.date,
              onSaved: () => {
                items = items.filter((x) => x.key !== it.key);
                if (items.length) paintReview(said);
                else dlg.close();
              },
            }),
          }, icon('pencil', 15)),
          h('button', {
            type: 'button', class: 'icon-btn sm', title: 'Remover', 'aria-label': `Remover ${it.description}`,
            onclick: () => {
              items = items.filter((x) => x.key !== it.key);
              if (items.length) paintReview(said);
              else {
                paintInput();
                text.value = said;
              }
            },
          }, icon('x', 15))));
    }));
    save.addEventListener('click', async () => {
      const rows = items.map(({ key, ...r }) => houseRow(r));
      const ok = await run(save, () => q(sb.from('transactions').insert(rows)), rows.length > 1 ? `${rows.length} lançamentos salvos.` : 'Lançamento salvo.');
      if (ok) {
        dlg.close();
        await reload();
      }
    });
    const again = h('button', {
      type: 'button', class: 'btn ghost',
      onclick: () => {
        paintInput();
        text.value = '';
        start();
      },
    }, icon('mic', 18), h('span', {}, 'Falar de novo'));
    body.replaceChildren(...[
      h('blockquote', { class: 'voice-quote' }, said),
      h('p', { class: 'hint' }, 'Confira o que a IA entendeu. Use o lápis para ajustar um item.'),
      list,
      note ? h('p', { class: 'hint' }, icon('sparkles', 14), ' ', note) : null,
      h('div', { class: 'dialog-actions' }, again, save)].filter(Boolean));
    save.focus();
  }

  paintInput();
  setListening(false);
  if (voiceSupported) start();       // abre já ouvindo: o clique no botão é o gesto que libera o microfone
  else text.focus();
}
