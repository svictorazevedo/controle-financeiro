import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickParse } from '../js/quickparse.js';

const today = '2026-11-21';   // sábado

test('saída simples com valor e data relativa', () => {
  const r = quickParse('Gastei 52,90 no mercado ontem', today);
  assert.equal(r.type, 'expense');
  assert.equal(r.amount_cents, 5290);
  assert.equal(r.date, '2026-11-20');
  assert.equal(r.description, 'Mercado');
});

test('entrada, milhar com ponto e "R$"', () => {
  const r = quickParse('recebi R$ 1.800 do freela', today);
  assert.equal(r.type, 'income');
  assert.equal(r.amount_cents, 180000);
  assert.equal(r.date, today);
  assert.equal(r.description, 'Freela');
});

test('"52 e 90" vira 52,90; "dia 3"; dia da semana', () => {
  assert.equal(quickParse('paguei 52 e 90 de farmácia', today).amount_cents, 5290);
  assert.equal(quickParse('uber 23 reais dia 3', today).date, '2026-11-03');
  assert.equal(quickParse('almoço 40 na quarta', today).date, '2026-11-18');
});

test('sem valor: deixa em branco para o usuário preencher', () => {
  const r = quickParse('comprei pão', today);
  assert.equal(r.amount_cents, null);
  assert.equal(r.description, 'Pão');
});
