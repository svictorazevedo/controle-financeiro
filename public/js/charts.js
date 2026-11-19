// Gráficos em SVG/HTML puros (sem bibliotecas externas => nada de CDN, CSP restrita).
import { h, s, $, brl, brlCompact, monthLabel } from './ui.js';

function showTip(ev, title, lines) {
  const tip = $('#tooltip');
  while (tip.firstChild) tip.removeChild(tip.firstChild);
  tip.append(h('b', {}, title), ...lines.map((l) => h('div', {}, l)));
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: W, innerHeight: H } = window;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > W - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > H - 8) y = ev.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => {
  $('#tooltip').hidden = true;
};

/** Gastos por categoria: barras horizontais, uma só cor (é magnitude, não identidade). */
export function categoryBars(items) {
  const max = Math.max(...items.map((i) => i.amount), 1);
  const total = items.reduce((a, i) => a + i.amount, 0);
  return h('div', { class: 'hbars', role: 'list' }, ...items.map((i) => {
    const pct = Math.round((i.amount / total) * 100);
    const row = h('div', { class: 'hbar', role: 'listitem' },
      h('span', { class: 'name', title: i.category }, i.category),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(i.amount / max) * 100}%` } })),
      h('span', { class: 'val' }, `${brl(i.amount)} · ${pct}%`));
    row.addEventListener('mousemove', (ev) => showTip(ev, i.category, [`${brl(i.amount)}`, `${pct}% dos gastos do mês`]));
    row.addEventListener('mouseleave', hideTip);
    return row;
  }));
}

function niceMax(v) {
  if (v <= 0) return 100_00;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

// Barra com cantos arredondados só no topo (ancorada na linha de base).
function barPath(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

/** Ganhos x gastos dos últimos meses: barras agrupadas, com legenda e dica ao passar o mouse. */
export function trendChart(trend) {
  const W = 640;
  const H = 240;
  const m = { top: 12, right: 8, bottom: 28, left: 64 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...trend.flatMap((t) => [t.income, t.expenses])));
  const y = (v) => m.top + ih - (v / max) * ih;
  const band = iw / trend.length;
  const barW = Math.min(28, (band * 0.6) / 2);
  const gap = 2;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Ganhos e gastos dos últimos 6 meses' });
  const axis = s('g', { class: 'axis' });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    const yy = y(v);
    svg.append(s('line', { class: k === 0 ? 'baseline' : 'gridline', x1: m.left, x2: W - m.right, y1: yy, y2: yy }));
    axis.append(s('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end' }, brlCompact(v)));
  }
  trend.forEach((t, i) => {
    const cx = m.left + band * i + band / 2;
    const xi = cx - barW - gap / 2;
    const xe = cx + gap / 2;
    svg.append(
      s('path', { class: 'bar-income', d: barPath(xi, y(t.income), barW, m.top + ih - y(t.income)) }),
      s('path', { class: 'bar-expense', d: barPath(xe, y(t.expenses), barW, m.top + ih - y(t.expenses)) }),
    );
    axis.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, `${monthLabel(t.month, true)}/${t.month.slice(2, 4)}`));
    const hit = s('rect', { class: 'hit', x: m.left + band * i, y: m.top, width: band, height: ih });
    hit.addEventListener('mousemove', (ev) => showTip(ev, monthLabel(t.month), [
      `Ganhos: ${brl(t.income)}`, `Gastos: ${brl(t.expenses)}`, `Saldo: ${brl(t.income - t.expenses)}`,
    ]));
    hit.addEventListener('mouseleave', hideTip);
    svg.insertBefore(hit, svg.firstChild);
  });
  svg.append(axis);

  const legend = h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { background: 'var(--series-income)' } }), 'Ganhos'),
    h('span', {}, h('i', { style: { background: 'var(--series-expense)' } }), 'Gastos'));

  // Tabela equivalente (acessibilidade / leitores de tela)
  const table = h('table', { class: 'sr-only' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Mês'), h('th', {}, 'Ganhos'), h('th', {}, 'Gastos'))),
    h('tbody', {}, ...trend.map((t) => h('tr', {}, h('td', {}, monthLabel(t.month)), h('td', {}, brl(t.income)), h('td', {}, brl(t.expenses))))));
  return h('div', {}, legend, svg, table);
}
