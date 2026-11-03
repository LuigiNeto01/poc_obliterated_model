import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../server.mjs';

test('API calcula o total', () => {
  assert.equal(quote({ quantity: '2', unitPrice: '19.90' }).total, 39.8);
});

test('API rejeita quantidade inválida', () => {
  assert.throws(() => quote({ quantity: '0', unitPrice: '1' }), RangeError);
});
