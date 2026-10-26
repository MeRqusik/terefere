// Spot currency exchange: balances per currency, market/limit/stop orders, fills against bid/ask.
export const FEE = 0.001;
export const START = { PLN: 100000 };
const SIDES = ['buy', 'sell'];
const TYPES = ['market', 'limit', 'stop'];
const round = (x) => Math.round(x * 1e8) / 1e8;

export const createAccount = () => ({ balances: { ...START }, orders: [], seq: 0 });

// What an open order locks: buy locks quote currency at its own price, sell locks the base amount.
function hold(o) {
  const [base, quote] = o.symbol.split('_');
  return o.side === 'buy' ? [quote, o.amount * o.price * (1 + FEE)] : [base, o.amount];
}

export function available(acc, except) {
  const a = { ...acc.balances };
  for (const o of acc.orders) {
    if (o.status !== 'open' || o === except) continue;
    const [c, v] = hold(o);
    a[c] = round((a[c] || 0) - v);
  }
  return a;
}

function fill(acc, o, q, now) {
  const [base, quote] = o.symbol.split('_');
  const px = o.side === 'buy' ? q.ask : q.bid;
  const notional = o.amount * px;
  const fee = notional * FEE;
  const [pay, cost] = o.side === 'buy' ? [quote, notional + fee] : [base, o.amount];
  if ((available(acc, o)[pay] || 0) < cost - 1e-9) {
    Object.assign(o, { status: 'cancelled', reason: 'Brak środków w chwili realizacji', closedAt: now });
    return o;
  }
  const b = acc.balances;
  if (o.side === 'buy') {
    b[quote] = round((b[quote] || 0) - cost);
    b[base] = round((b[base] || 0) + o.amount);
  } else {
    b[base] = round((b[base] || 0) - o.amount);
    b[quote] = round((b[quote] || 0) + notional - fee);
  }
  return Object.assign(o, { status: 'filled', fillPrice: px, fee: round(fee), closedAt: now });
}

export function placeOrder(acc, input, symbols, quote, now = Date.now()) {
  const { symbol, side, type } = input ?? {};
  const amount = Number(input?.amount);
  const price = type === 'market' ? null : Number(input?.price);
  if (!symbols.includes(symbol)) throw new Error('Nieznana para walutowa');
  if (!SIDES.includes(side) || !TYPES.includes(type)) throw new Error('Nieprawidłowy typ zlecenia');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new Error('Podaj poprawną ilość');
  if (price !== null && (!Number.isFinite(price) || price <= 0)) throw new Error('Podaj poprawną cenę');
  if (!quote) throw new Error('Brak notowań dla tej pary');

  const o = { id: ++acc.seq, symbol, side, type, amount, price, status: 'open', createdAt: now };
  if (type === 'market') {
    fill(acc, o, quote, now);
    if (o.status !== 'filled') throw new Error('Za mało środków');
  } else {
    const [c, v] = hold(o);
    if ((available(acc)[c] || 0) < v - 1e-9) throw new Error('Za mało środków');
  }
  acc.orders.push(o);
  return o;
}

export function cancelOrder(acc, id, now = Date.now()) {
  const o = acc.orders.find((x) => x.id === id && x.status === 'open');
  if (!o) throw new Error('Nie ma takiego otwartego zlecenia');
  return Object.assign(o, { status: 'cancelled', reason: 'Anulowane przez Ciebie', closedAt: now });
}

const triggered = (o, q) =>
  o.side === 'buy'
    ? o.type === 'limit' ? q.ask <= o.price : q.ask >= o.price
    : o.type === 'limit' ? q.bid >= o.price : q.bid <= o.price;

// Called on every quote; returns orders that were closed (filled or rejected) by it.
export function matchOrders(acc, symbol, q, now = Date.now()) {
  return acc.orders
    .filter((o) => o.status === 'open' && o.symbol === symbol && triggered(o, q))
    .map((o) => fill(acc, o, q, now));
}
