// Utilitários de interface. h() cria elementos de forma segura: textos viram nós de texto,
// nunca HTML interpretado — isso impede XSS mesmo que um lançamento tenha "<script>" na descrição.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'value' || k === 'hidden' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

// ---------------------------------------------------------------- dinheiro (moeda da casa)
export const CURRENCIES = [
  ['BRL', 'Real (R$)'], ['USD', 'Dólar americano (US$)'], ['EUR', 'Euro (€)'], ['GBP', 'Libra (£)'],
  ['ARS', 'Peso argentino'], ['CLP', 'Peso chileno'], ['MXN', 'Peso mexicano'], ['PYG', 'Guarani'],
  ['UYU', 'Peso uruguaio'], ['CAD', 'Dólar canadense'], ['JPY', 'Iene'], ['CHF', 'Franco suíço'],
];
let FMT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
let FMT_COMPACT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
export function setCurrency(code) {
  try {
    FMT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code || 'BRL' });
    FMT_COMPACT = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code || 'BRL', notation: 'compact', maximumFractionDigits: 1 });
  } catch {
    setCurrency('BRL');
  }
}
export const brl = (cents) => FMT.format((cents || 0) / 100);
export const brlCompact = (cents) => FMT_COMPACT.format((cents || 0) / 100);
/** Valor com sinal explícito (+/−), para extratos. */
export const money = (cents, signed = false) => (signed && cents > 0 ? `+${brl(cents)}` : brl(cents));

/** "1.234,56" / "1234,56" / "1234.56" / "R$ 50" -> centavos (inteiro) ou null. */
export function parseMoney(str, { allowNegative = false, allowZero = false } = {}) {
  let t = String(str || '').replace(/[R$\s ]/g, '').replace(/[A-Za-z€£¥]/g, '');
  let neg = false;
  if (allowNegative && /^[-−]/.test(t)) {
    neg = true;
    t = t.slice(1);
  }
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  if (cents === 0) return allowZero ? 0 : null;
  return neg ? -cents : cents;
}
export const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',');

/** "12,5" -> 1250 pontos-base. */
export function parsePercent(str) {
  const t = String(str || '').replace('%', '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(Number(t) * 100);
  return bp > 0 && bp <= 10000 ? bp : null;
}
export const bpToText = (bp) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
export const pctText = (ratio) => `${Math.round(ratio * 100)}%`;

// ---------------------------------------------------------------- datas
export function monthLabel(m, short = false) {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 1, 15));
  return short
    ? d.toLocaleDateString('pt-BR', { month: 'short', timeZone: 'UTC' }).replace('.', '')
    : d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export const dateBr = (d) => (d ? d.split('-').reverse().join('/') : '');
export function dateLong(d) {
  const x = new Date(`${d}T12:00:00Z`);
  return x.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
/** "Hoje", "Ontem", "Amanhã" ou "Seg., 18 de nov." — usa a data local do aparelho. */
export function dayLabel(d) {
  const t = new Date();
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const today = iso(t);
  const shift = (n) => iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n));
  if (d === today) return 'Hoje';
  if (d === shift(-1)) return 'Ontem';
  if (d === shift(1)) return 'Amanhã';
  const x = new Date(`${d}T12:00:00Z`);
  const s = x.toLocaleDateString('pt-BR', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC', ...(d.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function dateShort(d) {
  const x = new Date(`${d}T12:00:00Z`);
  return x.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' }).replace('.', '');
}

// ---------------------------------------------------------------- avisos
let toastTimer;
export function toast(msg, isError = false) {
  const t = $('#toast');
  clear(t);
  t.append(icon(isError ? 'alert' : 'check', 18), h('span', {}, msg));
  t.className = `show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = '';
  }, isError ? 5000 : 2600);
}

// ---------------------------------------------------------------- celular
/** Tela de celular (mesmo limite do CSS). No celular as janelas viram "folhas" que sobem de baixo. */
export const MOBILE_MQ = matchMedia('(max-width: 760px)');
export const isMobile = () => MOBILE_MQ.matches;

/** Arrastar a folha para baixo (pela alça/cabeçalho) fecha a janela. */
function swipeToClose(dlg, handle, close) {
  let y0 = null;
  let dy = 0;
  handle.addEventListener('touchstart', (e) => {
    if (!isMobile() || e.touches.length !== 1) return;
    y0 = e.touches[0].clientY;
    dy = 0;
    dlg.style.transition = 'none';
  }, { passive: true });
  handle.addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    dlg.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  const end = () => {
    if (y0 === null) return;
    y0 = null;
    dlg.style.transition = '';
    if (dy > 90) close();
    else dlg.style.transform = '';
  };
  handle.addEventListener('touchend', end);
  handle.addEventListener('touchcancel', end);
}

// ---------------------------------------------------------------- diálogos (substituem prompt/confirm)
/**
 * Abre um diálogo modal. `body` pode ser um <form>; nesse caso o envio é tratado por quem chamou.
 * No celular ele aparece como folha presa na parte de baixo da tela.
 * Devolve { el, close }.
 */
export function openDialog({ title, body, wide = false, onClose, cls = '' }) {
  const dlg = h('dialog', { class: `dialog${wide ? ' wide' : ''} ${cls}`, 'aria-label': title });
  const close = () => {
    if (dlg.open) dlg.close();
  };
  const head = h('header', { class: 'dialog-head' }, h('span', { class: 'grabber', 'aria-hidden': 'true' }), h('h2', {}, title),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fechar', onclick: close }, icon('x', 18)));
  dlg.append(head, h('div', { class: 'dialog-body' }, body));
  dlg.addEventListener('close', () => {
    dlg.remove();
    document.documentElement.classList.toggle('has-dialog', !!document.querySelector('dialog[open]'));
    onClose?.();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();      // clique fora
  });
  swipeToClose(dlg, head, close);
  document.body.append(dlg);
  dlg.showModal();
  document.documentElement.classList.add('has-dialog');
  // No celular, focar um campo de texto abre o teclado por cima da folha: só foca quando quem chamou pedir.
  if (!isMobile()) {
    const first = dlg.querySelector('.dialog-body input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .dialog-body select, .dialog-body textarea');
    first?.focus();
  } else {
    // Foco na própria folha (não no "X"), para leitores de tela anunciarem o título.
    dlg.tabIndex = -1;
    dlg.focus();
  }
  return { el: dlg, close };
}

/** Lista de ações em folha (celular): substitui o menu "⋮". items: [{label, icon, onclick, danger}] */
export function actionSheet(title, items) {
  let chosen = null;
  const list = h('div', { class: 'action-list' }, ...items.filter(Boolean).map((it) => h('button', {
    type: 'button', class: it.danger ? 'danger' : '',
    onclick: () => {
      chosen = it;
      d.close();
    },
  }, it.icon ? icon(it.icon, 20) : null, h('span', {}, it.label), it.hint ? h('small', {}, it.hint) : null)));
  const d = openDialog({ title, body: list, cls: 'sheet-actions', onClose: () => chosen?.onclick?.() });
  return d;
}

export function confirmDialog(message, { title = 'Confirmar', confirmText = 'Confirmar', danger = false, detail = null } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const yes = h('button', { type: 'button', class: `btn ${danger ? 'danger solid' : ''}` }, confirmText);
    const no = h('button', { type: 'button', class: 'btn ghost' }, 'Cancelar');
    const d = openDialog({
      title,
      body: h('div', { class: 'stack' },
        h('p', { class: 'confirm-msg' }, message),
        detail ? h('p', { class: 'hint' }, detail) : null,
        h('div', { class: 'dialog-actions' }, no, yes)),
      onClose: () => resolve(ok),
    });
    yes.addEventListener('click', () => {
      ok = true;
      d.close();
    });
    no.addEventListener('click', () => d.close());
    yes.focus();
  });
}

/** Baixa bytes/texto como arquivo. */
export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Menu suspenso simples (botão "⋮"). items: [{label, icon, onclick, danger}] */
export function menuButton(items, label = 'Ações') {
  const wrap = h('div', { class: 'menu' });
  const btn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more', 18));
  const list = h('div', { class: 'menu-list', role: 'menu', hidden: true });
  const closeMenu = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside, true);
  };
  const outside = (e) => {
    if (!wrap.contains(e.target)) closeMenu();
  };
  for (const it of items.filter(Boolean)) {
    list.append(h('button', {
      type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
      onclick: (e) => {
        closeMenu();
        it.onclick(e);
      },
    }, it.icon ? icon(it.icon, 16) : null, it.label));
  }
  btn.addEventListener('click', () => {
    if (isMobile()) {             // no celular: lista de ações grande, presa embaixo
      actionSheet(label === 'Ações' ? 'O que deseja fazer?' : label, items);
      return;
    }
    const open = list.hidden;
    if (open) {
      list.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const r = btn.getBoundingClientRect();
      list.classList.toggle('up', r.bottom + 180 > window.innerHeight);
      document.addEventListener('click', outside, true);
    } else closeMenu();
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      btn.focus();
    }
  });
  wrap.append(btn, list);
  return wrap;
}

/** Controle segmentado (rádios estilizados). */
export function segmented(name, options, value, onchange) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup' });
  for (const o of options) {
    const id = `${name}-${o.value}-${Math.random().toString(36).slice(2, 6)}`;
    const inp = h('input', { type: 'radio', name, id, value: o.value, checked: o.value === value });
    inp.addEventListener('change', () => onchange?.(o.value));
    wrap.append(inp, h('label', { for: id, class: o.cls ?? '' }, o.icon ? icon(o.icon, 16) : null, o.label));
  }
  wrap.value = () => wrap.querySelector('input:checked')?.value;
  return wrap;
}

/** Iniciais para avatar. */
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');

/** Reduz uma imagem para caber em w×h e devolve data URL (PNG ou JPEG). */
export function imageToDataUrl(file, maxW, maxH, type = 'image/png') {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      reject(new Error('Use uma imagem PNG, JPG ou WEBP.'));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(maxW / img.width, maxH / img.height, 1);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(type, 0.9));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível ler a imagem.'));
    };
    img.src = url;
  });
}
