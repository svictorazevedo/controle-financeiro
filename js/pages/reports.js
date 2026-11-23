// Relatórios: 8 prontos, com impressão, PDF e CSV.
import { state, page, card, field, input, select, routeParams } from '../ctx.js';
import { REPORTS, buildReport } from '../reports.js';
import { localToday, dateFor, addMonths } from '../finance.js';
import { h, brl, dateBr, monthLabel, download, pctText, toast } from '../ui.js';
import { icon } from '../icons.js';
import { tablePdf } from '../pdf.js';
import { trendChart } from '../charts.js';

const params = { r: 'entradas', from: null, to: null, month: null, ahead: 30, accountId: null };

function fmt(col, v, forCsv = false) {
  if (v === null || v === undefined || v === '') return '';
  switch (col.type) {
    case 'money':
      if (forCsv) return (v / 100).toFixed(2).replace('.', ',');
      return col.signed && v > 0 ? `+${brl(v)}` : brl(v);
    case 'date': return dateBr(v);
    case 'month': return v === 'Total' ? v : forCsv ? v : `${monthLabel(v, true)}/${v.slice(0, 4)}`;
    case 'percent': return forCsv ? (v * 100).toFixed(1).replace('.', ',') : pctText(v);
    case 'int': return String(v);
    default: return String(v);
  }
}

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = `'${s}`;   // evita fórmulas no Excel
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function filename(rep, ext) {
  const base = rep.title.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  return `${base}_${localToday()}.${ext}`;
}

export async function renderReports() {
  const qp = routeParams();
  if (qp.get('r')) params.r = qp.get('r');
  if (qp.get('conta')) params.accountId = qp.get('conta');
  const d = state.d;
  const today = localToday();
  params.from ??= `${state.month}-01`;
  params.to ??= dateFor(state.month, 31);
  params.month ??= state.month;
  params.accountId ??= d.accounts.find((a) => !a.archived)?.id ?? null;
  const def = REPORTS.find((x) => x.id === params.r) ?? REPORTS[0];

  const rep = buildReport(def.id, d, { ...params, today });

  // Parâmetros
  const controls = [];
  const rerun = () => renderReports();
  if (def.params.includes('account')) {
    const acc = select('acc', d.accounts.map((a) => ({ value: a.id, label: a.name + (a.archived ? ' (arquivada)' : '') })), params.accountId);
    acc.addEventListener('change', () => {
      params.accountId = acc.value;
      rerun();
    });
    controls.push(field('Conta', acc));
  }
  if (def.params.includes('period')) {
    const from = input('from', { type: 'date', value: params.from });
    const to = input('to', { type: 'date', value: params.to });
    const apply = () => {
      if (from.value && to.value && from.value <= to.value) {
        params.from = from.value;
        params.to = to.value;
        rerun();
      }
    };
    from.addEventListener('change', apply);
    to.addEventListener('change', apply);
    const quick = select('quick', [
      { value: '', label: 'Atalhos de período…' }, { value: 'm', label: `Mês selecionado (${monthLabel(state.month)})` },
      { value: '3', label: 'Últimos 3 meses' }, { value: '6', label: 'Últimos 6 meses' }, { value: 'y', label: `Ano de ${state.month.slice(0, 4)}` },
    ], '');
    quick.addEventListener('change', () => {
      const m = state.month;
      if (quick.value === 'm') [params.from, params.to] = [`${m}-01`, dateFor(m, 31)];
      if (quick.value === '3' || quick.value === '6') [params.from, params.to] = [`${addMonths(m, -Number(quick.value) + 1)}-01`, dateFor(m, 31)];
      if (quick.value === 'y') [params.from, params.to] = [`${m.slice(0, 4)}-01-01`, `${m.slice(0, 4)}-12-31`];
      rerun();
    });
    controls.push(field('De', from), field('Até', to), field('Período', quick));
  }
  if (def.params.includes('ahead')) {
    const ahead = select('ahead', [7, 15, 30, 60, 90].map((n) => ({ value: String(n), label: `Próximos ${n} dias` })), String(params.ahead));
    ahead.addEventListener('change', () => {
      params.ahead = Number(ahead.value);
      rerun();
    });
    controls.push(field('Horizonte', ahead));
  }
  if (def.params.includes('month')) {
    const m = input('month', { type: 'month', value: params.month });
    m.addEventListener('change', () => {
      if (m.value) {
        params.month = m.value;
        rerun();
      }
    });
    controls.push(field('Até o mês', m));
  }

  // Tabela
  const table = h('table', { class: 'data report' },
    h('thead', {}, h('tr', {}, ...rep.columns.map((c) => h('th', { class: c.align === 'right' ? 'num' : '' }, c.label)))),
    h('tbody', {}, ...rep.rows.map((r) => h('tr', { class: r.muted ? 'dim' : '' }, ...rep.columns.map((c) => {
      const v = r[c.key];
      const tone = c.signed && typeof v === 'number' ? (v < 0 ? 'neg' : v > 0 ? 'pos' : '') : '';
      return h('td', { class: `${c.align === 'right' ? 'num' : ''} ${tone}` },
        c.swatch && r[c.swatch] ? h('span', { class: 'cat-chip' }, h('i', { style: { background: r[c.swatch] } }), fmt(c, v)) : fmt(c, v));
    })))),
    rep.footer ? h('tfoot', {}, h('tr', {}, ...rep.columns.map((c) => h('td', { class: c.align === 'right' ? 'num' : '' }, fmt(c, rep.footer[c.key]))))) : null);

  const org = d.house.name;
  const generated = `Gerado em ${new Date().toLocaleString('pt-BR')}`;
  const toPdf = () => {
    const bytes = tablePdf({
      title: rep.title, subtitle: rep.subtitle.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$3/$2/$1'), org, generatedAt: generated,
      columns: rep.columns.map((c) => ({ label: c.label, align: c.align, weight: c.key === 'description' ? 3 : c.key === 'category' ? 2 : c.type === 'money' ? 1.4 : 1 })),
      rows: rep.rows.map((r) => rep.columns.map((c) => fmt(c, r[c.key]))),
      footer: rep.footer ? rep.columns.map((c) => fmt(c, rep.footer[c.key])) : null,
    });
    download(filename(rep, 'pdf'), new Blob([bytes], { type: 'application/pdf' }));
    toast('PDF gerado.');
  };
  const toCsv = () => {
    const lines = [rep.columns.map((c) => csvCell(c.label)).join(';')];
    for (const r of rep.rows) lines.push(rep.columns.map((c) => csvCell(fmt(c, r[c.key], true))).join(';'));
    if (rep.footer) lines.push(rep.columns.map((c) => csvCell(fmt(c, rep.footer[c.key], true))).join(';'));
    download(filename(rep, 'csv'), `﻿${lines.join('\r\n')}`, 'text/csv;charset=utf-8');
  };

  const list = h('nav', { class: 'report-list', 'aria-label': 'Relatórios' }, ...REPORTS.map((x, i) => h('a', {
    href: `#/relatorios?r=${x.id}`, class: x.id === def.id ? 'active' : '', 'aria-current': x.id === def.id ? 'page' : null,
  }, h('span', { class: 'rep-n' }, String(i + 1)), h('span', {}, h('strong', {}, x.title), h('small', {}, x.desc)))));

  const chart = rep.chart && rep.rows.length > 1
    ? trendChart(rep.rows.map((r) => ({ month: r.month, income: r.income, expenses: r.expense })), { height: 200 }) : null;

  page('Relatórios', {
    subtitle: 'Escolha um relatório, ajuste o período e exporte',
    actions: [
      h('button', { type: 'button', class: 'btn ghost', onclick: () => window.print() }, icon('printer', 18), h('span', {}, 'Imprimir')),
      h('button', { type: 'button', class: 'btn ghost', onclick: toCsv }, icon('download', 18), h('span', {}, 'CSV')),
      h('button', { type: 'button', class: 'btn', onclick: toPdf }, icon('report', 18), h('span', {}, 'PDF')),
    ],
  },
  h('div', { class: 'reports-layout' },
    list,
    h('div', { class: 'report-main' },
      controls.length ? h('div', { class: 'card toolbar report-params' }, ...controls) : null,
      card(null, { cls: 'report-card' },
        h('div', { class: 'print-head' },
          d.house.logo ? h('img', { src: d.house.logo, alt: '', class: 'print-logo' }) : null,
          h('div', {}, h('small', {}, org), h('h2', {}, rep.title), h('p', { class: 'muted' }, rep.subtitle.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$3/$2/$1')))),
        rep.summary ? h('div', { class: 'summary-strip compact' },
          h('div', {}, h('span', {}, 'Entradas'), h('strong', { class: 'num pos' }, brl(rep.summary.income))),
          h('div', {}, h('span', {}, 'Saídas'), h('strong', { class: 'num neg' }, brl(rep.summary.expense))),
          h('div', {}, h('span', {}, 'Saldo final'), h('strong', { class: 'num' }, brl(rep.footer?.balance ?? 0)))) : null,
        chart,
        rep.rows.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted center' }, 'Nenhum registro para os filtros escolhidos.'),
        h('p', { class: 'hint print-only' }, generated)))));
  // No celular a lista é uma faixa horizontal: deixa o relatório escolhido visível.
  const act = list.querySelector('a.active');
  if (act && list.scrollWidth > list.clientWidth) {
    const r = act.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    list.scrollLeft += r.left - l.left - (l.width - r.width) / 2;
  }
}
