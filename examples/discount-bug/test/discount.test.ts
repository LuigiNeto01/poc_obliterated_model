import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountRate, finalPrice, type Customer } from '../src/discount.ts';

const ana: Customer = { name: 'Ana', tier: 'regular' };
const bia: Customer = { name: 'Bia', tier: 'vip' };

test('sem desconto abaixo de R$ 100', () => {
  assert.equal(finalPrice(99.99, ana), 99.99);
});

test('10% de desconto a partir de R$ 100 (inclusive)', () => {
  assert.equal(finalPrice(100, ana), 90);
});

test('10% de desconto acima de R$ 100', () => {
  assert.equal(finalPrice(250, ana), 225);
});

test('cliente VIP ganha 5% adicionais', () => {
  assert.equal(discountRate(200, bia), 0.15);
});

test('desconto total limitado a 25%', () => {
  assert.equal(discountRate(500, bia, 'SAVE10'), 0.25);
  assert.equal(finalPrice(500, bia, 'SAVE10'), 375);
});

test('subtotal negativo é rejeitado', () => {
  assert.throws(() => finalPrice(-1, ana), RangeError);
});
