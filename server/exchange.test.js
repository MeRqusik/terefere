import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, placeOrder, cancelOrder, matchOrders, available } from './exchange.js';
import { crossQuote } from './market.js';

const SYMS = ['EUR_PLN', 'USD_PLN'];
const q = (bid, ask) => ({ bid, ask, ts: 0 });

test('market buy pays ask plus fee in quote currency', () => {
  const acc = createAccount();
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 1000 }, SYMS, q(4.3, 4.4));
  assert.equal(acc.balances.EUR, 1000);
  assert.equal(acc.balances.PLN, 100000 - 4400 - 4.4);
});

test('market sell receives bid minus fee', () => {
  const acc = createAccount();
  acc.balances.EUR = 500;
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'market', amount: 500 }, SYMS, q(4.3, 4.4));
  assert.equal(acc.balances.EUR, 0);
  assert.equal(acc.balances.PLN, 100000 + 2150 - 2.15);
});

test('rejects bad input and missing funds', () => {
  const acc = createAccount();
  const bad = [
    { symbol: 'XXX_PLN', side: 'buy', type: 'market', amount: 1 },
    { symbol: 'EUR_PLN', side: 'hold', type: 'market', amount: 1 },
    { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: -5 },
    { symbol: 'EUR_PLN', side: 'buy', type: 'limit', amount: 1, price: 'abc' },
    { symbol: 'EUR_PLN', side: 'sell', type: 'market', amount: 1 },
    { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 1e6 },
  ];
  for (const o of bad) assert.throws(() => placeOrder(acc, o, SYMS, q(4.3, 4.4)));
  assert.deepEqual(acc.balances, { PLN: 100000 });
  assert.equal(acc.orders.length, 0);
});

test('limit buy holds funds, fills when ask drops to limit, cancel releases hold', () => {
  const acc = createAccount();
  const o = placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'limit', amount: 10000, price: 4.2 }, SYMS, q(4.3, 4.4));
  assert.equal(available(acc).PLN, 57958);
  assert.throws(() => placeOrder(acc, { symbol: 'USD_PLN', side: 'buy', type: 'limit', amount: 20000, price: 3 }, SYMS, q(3.9, 4)));
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.25, 4.21)).length, 0);
  const [f] = matchOrders(acc, 'EUR_PLN', q(4.19, 4.2));
  assert.equal(f, o);
  assert.equal(o.status, 'filled');
  assert.equal(acc.balances.EUR, 10000);

  const o2 = placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'limit', amount: 5000, price: 5 }, SYMS, q(4.3, 4.4));
  assert.equal(available(acc).EUR, 5000);
  cancelOrder(acc, o2.id);
  assert.equal(available(acc).EUR, 10000);
  assert.throws(() => cancelOrder(acc, o2.id));
});

test('stop sell triggers when bid falls to stop', () => {
  const acc = createAccount();
  acc.balances.EUR = 100;
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'stop', amount: 100, price: 4.2 }, SYMS, q(4.3, 4.4));
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.25, 4.3)).length, 0);
  const [f] = matchOrders(acc, 'EUR_PLN', q(4.1, 4.15));
  assert.equal(f.fillPrice, 4.1);
  assert.equal(acc.balances.EUR, 0);
});

test('stop buy that slips past available funds is rejected, not overdrawn', () => {
  const acc = createAccount();
  const o = placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'stop', amount: 20000, price: 4.5 }, SYMS, q(4.3, 4.4));
  placeOrder(acc, { symbol: 'USD_PLN', side: 'buy', type: 'market', amount: 2000, price: 0 }, SYMS, q(3.9, 4));
  matchOrders(acc, 'EUR_PLN', q(5.4, 5.5));
  assert.equal(o.status, 'cancelled');
  assert.ok(acc.balances.PLN > 0);
});

test('simulated cross rates stay consistent (no triangular arbitrage)', () => {
  const v = { USD: 1, EUR: 1.12, JPY: 1 / 157, PLN: 1 / 3.93 };
  const mid = (s) => { const x = crossQuote(s, v, 0, 0); return (x.bid + x.ask) / 2; };
  assert.ok(Math.abs(mid('EUR_JPY') - mid('EUR_USD') * mid('USD_JPY')) < 1e-9);
  assert.ok(Math.abs(mid('EUR_PLN') - 1.12 * 3.93) < 1e-9);
});
