// Gráficos em SVG/HTML puros (sem bibliotecas externas => nada de CDN, CSP restrita).
import { h, s, $, brl, brlCompact, monthLabel, isMobile } from './ui.js';

// No toque não existe "mouseleave": tocar fora do gráfico ou rolar a tela esconde a dica.
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' && !e.target.closest?.('.chart, .donut')) hideTip();
}, { passive: true });
addEventListener('scroll', () => hideTip(), { passive: true });

function showTip(ev, title, lines) {
  const tip = $('#tooltip');
  while (tip.firstChild) tip.removeChild(tip.firstChild);
  tip.append(h('b', {}, title), ...lines.map((l) => (Array.isArray(l)
    ? h('div', { class: 'tip-row' }, h('i', { style: { background: l[0] } }), h('span', {}, l[1]), h('strong', {}, l[2]))
    : h('div', {}, l))));
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
export const hideTip = () => {
  $('#tooltip').hidden = true;
};

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

/** Entradas x saídas por mês: barras agrupadas, com legenda, dica e tabela para leitores de tela. */
export function trendChart(trend, { height = 240, current = null } = {}) {
  // No celular o desenho é feito numa largura menor: o texto do eixo fica legível em vez de encolher.
  const small = isMobile();
  const W = small ? 360 : 640;
  const H = small ? 220 : height;
  const m = { top: 12, right: 6, bottom: 28, left: small ? 52 : 64 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const max = niceMax(Math.max(...trend.flatMap((t) => [t.income, t.expenses])));
  const y = (v) => m.top + ih - (v / max) * ih;
  const band = iw / trend.length;
  const barW = Math.min(26, (band * 0.62) / 2);
  const gap = 2;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Entradas e saídas dos últimos ${trend.length} meses` });
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
    const hit = s('rect', { class: `hit${t.month === current ? ' current' : ''}`, x: m.left + band * i + 2, y: m.top, width: band - 4, height: ih, rx: 6 });
    const tip = (ev) => showTip(ev, monthLabel(t.month), [
      ['var(--series-income)', 'Entradas', brl(t.income)],
      ['var(--series-expense)', 'Saídas', brl(t.expenses)],
      `Resultado: ${brl(t.income - t.expenses)}`,
    ]);
    hit.addEventListener('mousemove', tip);
    hit.addEventListener('click', tip);          // toque no celular
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit,
      s('path', { class: 'bar-income', d: barPath(xi, y(t.income), barW, m.top + ih - y(t.income)) }),
      s('path', { class: 'bar-expense', d: barPath(xe, y(t.expenses), barW, m.top + ih - y(t.expenses)) }));
    axis.append(s('text', { x: cx, y: H - 8, 'text-anchor': 'middle', class: t.month === current ? 'cur' : '' }, `${monthLabel(t.month, true)}/${t.month.slice(2, 4)}`));
  });
  svg.append(axis);

  const legend = h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { background: 'var(--series-income)' } }), 'Entradas'),
    h('span', {}, h('i', { style: { background: 'var(--series-expense)' } }), 'Saídas'));
  const table = h('table', { class: 'sr-only' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Mês'), h('th', {}, 'Entradas'), h('th', {}, 'Saídas'))),
    h('tbody', {}, ...trend.map((t) => h('tr', {}, h('td', {}, monthLabel(t.month)), h('td', {}, brl(t.income)), h('td', {}, brl(t.expenses))))));
  return h('div', { class: 'chart' }, legend, svg, table);
}

const FALLBACK = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

/** Rosca de participação (até 6 fatias + "Outros"), com legenda e valores. */
export function donut(items, { total: totalLabel = 'Total', max = 6 } = {}) {
  const sorted = [...items].filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
  const top = sorted.slice(0, max).map((x, i) => ({ ...x, color: x.color || FALLBACK[i % FALLBACK.length] }));
  const rest = sorted.slice(max);
  if (rest.length) top.push({ category: `Outros (${rest.length})`, amount: rest.reduce((a, x) => a + x.amount, 0), color: 'var(--muted-mark)' });
  const total = top.reduce((a, x) => a + x.amount, 0);
  const R = 70;
  const r = 50;
  const svg = s('svg', { viewBox: '0 0 160 160', class: 'donut', role: 'img', 'aria-label': 'Participação por categoria' });
  let a0 = -Math.PI / 2;
  const gapA = top.length > 1 ? 0.025 : 0;
  for (const x of top) {
    const frac = x.amount / total;
    const a1 = a0 + frac * Math.PI * 2;
    const s0 = a0 + gapA / 2;
    const s1 = Math.max(a1 - gapA / 2, s0 + 0.001);
    const large = s1 - s0 > Math.PI ? 1 : 0;
    const p = (ang, rad) => `${80 + rad * Math.cos(ang)},${80 + rad * Math.sin(ang)}`;
    const d = frac >= 0.9999
      ? `M80,${80 - R}A${R},${R} 0 1 1 79.99,${80 - R}L79.99,${80 - r}A${r},${r} 0 1 0 80,${80 - r}Z`
      : `M${p(s0, R)}A${R},${R} 0 ${large} 1 ${p(s1, R)}L${p(s1, r)}A${r},${r} 0 ${large} 0 ${p(s0, r)}Z`;
    const seg = s('path', { d, fill: x.color, class: 'slice' });
    seg.addEventListener('mousemove', (ev) => showTip(ev, x.category, [`${brl(x.amount)} · ${Math.round(frac * 100)}%`]));
    seg.addEventListener('click', (ev) => showTip(ev, x.category, [`${brl(x.amount)} · ${Math.round(frac * 100)}%`]));
    seg.addEventListener('mouseleave', hideTip);
    svg.append(seg);
    a0 = a1;
  }
  svg.append(
    s('text', { x: 80, y: 76, 'text-anchor': 'middle', class: 'donut-label' }, totalLabel),
    s('text', { x: 80, y: 94, 'text-anchor': 'middle', class: 'donut-value' }, brlCompact(total)));
  const legend = h('ul', { class: 'donut-legend' }, ...top.map((x) => h('li', {},
    h('i', { style: { background: x.color } }),
    h('span', { class: 'name', title: x.category }, x.category),
    h('span', { class: 'pct' }, `${Math.round((x.amount / total) * 100)}%`),
    h('span', { class: 'val num' }, brl(x.amount)))));
  return h('div', { class: 'donut-wrap' }, svg, legend);
}

/** Barra de progresso (orçamento/metas). status: ok | warn | over | done */
export function progress(ratio, status = 'ok', color = null) {
  return h('div', { class: `progress ${status}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(Math.min(ratio, 1) * 100) },
    h('div', { style: { width: `${Math.min(Math.max(ratio, 0), 1) * 100}%`, ...(color ? { background: color } : {}) } }));
}

/** Anel de progresso para metas. */
export function ring(ratio, color = 'var(--accent)', size = 64) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return s('svg', { viewBox: '0 0 64 64', width: size, height: size, class: 'ring', 'aria-hidden': 'true' },
    s('circle', { cx: 32, cy: 32, r, class: 'ring-track' }),
    s('circle', {
      cx: 32, cy: 32, r, class: 'ring-fill', stroke: color,
      'stroke-dasharray': `${(c * Math.min(ratio, 1)).toFixed(2)} ${c.toFixed(2)}`, transform: 'rotate(-90 32 32)',
    }),
    s('text', { x: 32, y: 36.5, 'text-anchor': 'middle', class: 'ring-text' }, `${Math.round(ratio * 100)}%`));
}
