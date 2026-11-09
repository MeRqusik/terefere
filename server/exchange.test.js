import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, placeOrder, cancelOrder, matchOrders, closePosition, protectPosition, available } from './exchange.js';
import { crossQuote, rateIn } from './market.js';

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
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.25, 4.21)).orders.length, 0);
  const [f] = matchOrders(acc, 'EUR_PLN', q(4.19, 4.2)).orders;
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
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.25, 4.3)).orders.length, 0);
  const [f] = matchOrders(acc, 'EUR_PLN', q(4.1, 4.15)).orders;
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

// Leverage: margin and result in PLN. EUR_PLN quotes are already in PLN; USD is worth 4 PLN.
const rate = (c) => ({ PLN: 1, USD: 4, EUR: 4.4 })[c];
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('long 10x takes margin + fee in PLN and pays the result back on close', () => {
  const acc = createAccount();
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 10000, leverage: 10 }, SYMS, q(4.3, 4.4), rate);
  const [p] = acc.positions;
  assert.equal(p.side, 'long');
  close(p.margin, 4400);
  close(acc.balances.PLN, 100000 - 4400 - 4.4);
  assert.equal(acc.balances.EUR, undefined);
  closePosition(acc, p.id, q(4.5, 4.6), rate);
  close(p.pnl, (4.5 - 4.4) * 10000 - 4.4 - 4.5);
  close(acc.balances.PLN, 100000 + p.pnl);
});

test('short profits when price falls, margin for a USD-quoted pair is converted to PLN', () => {
  const acc = createAccount();
  placeOrder(acc, { symbol: 'USD_PLN', side: 'sell', type: 'market', amount: 1000, leverage: 5 }, ['USD_PLN', 'EUR_USD'], q(4, 4.01), rate);
  close(acc.positions[0].margin, 800);
  placeOrder(acc, { symbol: 'EUR_USD', side: 'buy', type: 'market', amount: 1000, leverage: 100 }, ['USD_PLN', 'EUR_USD'], q(1.1, 1.1), rate);
  close(acc.positions[1].margin, 1000 * 1.1 * 4 / 100);
  closePosition(acc, acc.positions[0].id, q(3.89, 3.9), rate);
  assert.ok(acc.positions[0].pnl > 0);
});

test('position is liquidated at half the margin and never costs more than the margin', () => {
  const acc = createAccount();
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 100000, leverage: 100 }, SYMS, q(4.4, 4.4), rate);
  const [p] = acc.positions;
  close(p.margin, 4400);
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.39, 4.39), rate).positions.length, 0);
  const [liq] = matchOrders(acc, 'EUR_PLN', q(3, 3), rate).positions;
  assert.equal(liq.status, 'liquidated');
  close(liq.pnl, -p.margin - p.fee);
  close(acc.balances.PLN, 100000 - p.margin - p.fee);
});

test('leveraged limit order holds PLN and rejects bad leverage', () => {
  const acc = createAccount();
  for (const leverage of [0, 101, 2.5, 'x']) {
    assert.throws(() => placeOrder(acc, { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 1, leverage }, SYMS, q(4.3, 4.4), rate));
  }
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'limit', amount: 100000, price: 5, leverage: 10 }, SYMS, q(4.3, 4.4), rate);
  close(available(acc).PLN, 100000 - 50000 - 50);
  assert.equal(matchOrders(acc, 'EUR_PLN', q(5, 5.1), rate).orders[0].status, 'filled');
  assert.equal(acc.positions[0].side, 'short');
  close(acc.balances.PLN, 100000 - 50000 - 50);
});

test('rateIn converts through USD crosses', () => {
  const quotes = { EUR_USD: q(1.1, 1.1), USD_PLN: q(4, 4), USD_JPY: q(150, 150) };
  close(rateIn(quotes, 'EUR', 'PLN'), 4.4);
  close(rateIn(quotes, 'JPY', 'PLN'), 4 / 150);
  close(rateIn(quotes, 'PLN', 'PLN'), 1);
});

test('stop loss closes a long when bid falls to it, take profit closes a short', () => {
  const acc = createAccount();
  const long = { symbol: 'EUR_PLN', side: 'buy', type: 'market', amount: 1000, leverage: 10, sl: 4.3, tp: 4.6 };
  placeOrder(acc, long, SYMS, q(4.39, 4.4), rate);
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'market', amount: 1000, leverage: 10, tp: 4.2 }, SYMS, q(4.39, 4.4), rate);
  const [l, s] = acc.positions;
  assert.deepEqual([l.sl, l.tp, s.sl, s.tp], [4.3, 4.6, null, 4.2]);
  assert.equal(matchOrders(acc, 'EUR_PLN', q(4.31, 4.32), rate).positions.length, 0);
  const [hit] = matchOrders(acc, 'EUR_PLN', q(4.29, 4.3), rate).positions;
  assert.deepEqual([hit, hit.status, hit.reason, hit.exit], [l, 'closed', 'sl', 4.29]);
  const [tp] = matchOrders(acc, 'EUR_PLN', q(4.19, 4.2), rate).positions;
  assert.deepEqual([tp, tp.reason], [s, 'tp']);
  assert.ok(s.pnl > 0);
});

test('stop loss and take profit must sit on the right side of the price', () => {
  const acc = createAccount();
  const base = { symbol: 'EUR_PLN', type: 'market', amount: 1000, leverage: 10 };
  assert.throws(() => placeOrder(acc, { ...base, side: 'buy', sl: 4.5 }, SYMS, q(4.39, 4.4), rate), /poniżej/);
  assert.throws(() => placeOrder(acc, { ...base, side: 'buy', tp: 4.3 }, SYMS, q(4.39, 4.4), rate), /powyżej/);
  assert.throws(() => placeOrder(acc, { ...base, side: 'sell', sl: 4.3 }, SYMS, q(4.39, 4.4), rate), /powyżej/);
  assert.throws(() => placeOrder(acc, { ...base, side: 'buy', sl: 'abc' }, SYMS, q(4.39, 4.4), rate), /poprawną/);
  assert.throws(() => placeOrder(acc, { ...base, leverage: undefined, side: 'buy', sl: 4 }, SYMS, q(4.39, 4.4), rate), /dźwignią/);
  assert.equal(acc.positions.length, 0);
  // A limit order is checked against its own price, and passes SL/TP on to the position it opens.
  placeOrder(acc, { ...base, type: 'limit', price: 4.2, side: 'buy', sl: 4.1, tp: 4.35 }, SYMS, q(4.39, 4.4), rate);
  matchOrders(acc, 'EUR_PLN', q(4.19, 4.2), rate);
  assert.deepEqual([acc.positions[0].sl, acc.positions[0].tp], [4.1, 4.35]);
});

test('protectPosition sets, validates and clears SL/TP on an open position', () => {
  const acc = createAccount();
  placeOrder(acc, { symbol: 'EUR_PLN', side: 'sell', type: 'market', amount: 1000, leverage: 5 }, SYMS, q(4.39, 4.4), rate);
  const [p] = acc.positions;
  assert.throws(() => protectPosition(acc, p.id, { sl: 4.3 }, q(4.39, 4.4)), /powyżej/);
  protectPosition(acc, p.id, { sl: 4.5, tp: 4.1 }, q(4.39, 4.4));
  assert.deepEqual([p.sl, p.tp], [4.5, 4.1]);
  protectPosition(acc, p.id, { sl: '', tp: 4.2 }, q(4.39, 4.4));
  assert.deepEqual([p.sl, p.tp], [null, 4.2]);
  assert.throws(() => protectPosition(acc, 999, {}, q(4.39, 4.4)));
});
