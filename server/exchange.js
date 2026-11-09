// Spot currency exchange plus leveraged positions whose margin and result are kept in PLN.
export const FEE = 0.001; // spot commission
export const MARGIN_FEE = 0.0001; // per side on leveraged positions
export const MAX_LEVERAGE = 100;
export const CLOSE_OUT = 0.5; // ESMA-style margin close-out: liquidate when equity falls to half the margin
export const ACCOUNT = 'PLN';
export const START = { PLN: 100000 };
const SIDES = ['buy', 'sell'];
const TYPES = ['market', 'limit', 'stop'];
const round = (x) => Math.round(x * 1e8) / 1e8;
const optional = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// Stop loss sits on the losing side of the reference price, take profit on the winning side.
function protection(long, ref, input) {
  const sl = optional(input?.sl);
  const tp = optional(input?.tp);
  for (const [v, name] of [[sl, 'Stop loss'], [tp, 'Take profit']]) if (v !== null && !(Number.isFinite(v) && v > 0)) throw new Error(`${name}: podaj poprawną cenę`);
  if (sl !== null && (long ? sl >= ref : sl <= ref)) throw new Error(`Stop loss dla ${long ? 'long' : 'short'} musi być ${long ? 'poniżej' : 'powyżej'} ceny`);
  if (tp !== null && (long ? tp <= ref : tp >= ref)) throw new Error(`Take profit dla ${long ? 'long' : 'short'} musi być ${long ? 'powyżej' : 'poniżej'} ceny`);
  return { sl, tp };
}

export const createAccount = () => ({ balances: { ...START }, orders: [], positions: [], seq: 0 });

// PLN locked by a leveraged order or position: margin plus the opening fee.
const marginCost = (amount, price, rateQuote, leverage) => {
  const notional = amount * price * rateQuote;
  return [notional / leverage, notional * MARGIN_FEE];
};

// What an open order locks: spot buy locks quote currency, spot sell the base amount, leveraged orders PLN.
function hold(o) {
  if (o.hold) return o.hold;
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

const reject = (o, reason, now) => Object.assign(o, { status: 'cancelled', reason, closedAt: now });

function fill(acc, o, q, rate, now) {
  const [base, quote] = o.symbol.split('_');
  const px = o.side === 'buy' ? q.ask : q.bid;
  const b = acc.balances;

  if (o.leverage) {
    const [margin, fee] = marginCost(o.amount, px, rate(quote), o.leverage);
    if (!(margin > 0)) return reject(o, 'Brak kursu przeliczeniowego na PLN', now);
    if ((available(acc, o)[ACCOUNT] || 0) < margin + fee - 1e-9) return reject(o, 'Za mało PLN na depozyt', now);
    b[ACCOUNT] = round((b[ACCOUNT] || 0) - margin - fee);
    acc.positions.push({
      id: o.id, symbol: o.symbol, side: o.side === 'buy' ? 'long' : 'short', amount: o.amount, leverage: o.leverage,
      entry: px, margin: round(margin), fee: round(fee), sl: o.sl ?? null, tp: o.tp ?? null, status: 'open', openedAt: now,
    });
    return Object.assign(o, { status: 'filled', fillPrice: px, fee: round(fee), closedAt: now });
  }

  const notional = o.amount * px;
  const fee = notional * FEE;
  const [pay, cost] = o.side === 'buy' ? [quote, notional + fee] : [base, o.amount];
  if ((available(acc, o)[pay] || 0) < cost - 1e-9) return reject(o, 'Brak środków w chwili realizacji', now);
  if (o.side === 'buy') {
    b[quote] = round((b[quote] || 0) - cost);
    b[base] = round((b[base] || 0) + o.amount);
  } else {
    b[base] = round((b[base] || 0) - o.amount);
    b[quote] = round((b[quote] || 0) + notional - fee);
  }
  return Object.assign(o, { status: 'filled', fillPrice: px, fee: round(fee), closedAt: now });
}

const noRate = () => NaN;

export function placeOrder(acc, input, symbols, quote, rate = noRate, now = Date.now()) {
  const { symbol, side, type } = input ?? {};
  const amount = Number(input?.amount);
  const price = type === 'market' ? null : Number(input?.price);
  const leverage = input?.leverage == null ? null : Number(input.leverage);
  if (!symbols.includes(symbol)) throw new Error('Nieznana para walutowa');
  if (!SIDES.includes(side) || !TYPES.includes(type)) throw new Error('Nieprawidłowy typ zlecenia');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw new Error('Podaj poprawną ilość');
  if (price !== null && (!Number.isFinite(price) || price <= 0)) throw new Error('Podaj poprawną cenę');
  if (leverage !== null && !(Number.isInteger(leverage) && leverage >= 1 && leverage <= MAX_LEVERAGE)) throw new Error(`Dźwignia od 1 do ${MAX_LEVERAGE}`);
  if (!quote) throw new Error('Brak notowań dla tej pary');
  const wantsProtection = optional(input?.sl) !== null || optional(input?.tp) !== null;
  if (wantsProtection && !leverage) throw new Error('Stop loss i take profit są dla pozycji z dźwignią');

  const o = { id: ++acc.seq, symbol, side, type, amount, price, status: 'open', createdAt: now };
  if (leverage) o.leverage = leverage;
  if (wantsProtection) Object.assign(o, protection(side === 'buy', price ?? (side === 'buy' ? quote.ask : quote.bid), input));
  if (type === 'market') {
    fill(acc, o, quote, rate, now);
    if (o.status !== 'filled') throw new Error(o.reason === 'Brak środków w chwili realizacji' ? 'Za mało środków' : o.reason);
  } else {
    if (leverage) {
      const [margin, fee] = marginCost(amount, price, rate(symbol.split('_')[1]), leverage);
      if (!(margin > 0)) throw new Error('Brak kursu przeliczeniowego na PLN');
      o.hold = [ACCOUNT, margin + fee];
    }
    const [c, v] = hold(o);
    if ((available(acc)[c] || 0) < v - 1e-9) throw new Error(leverage ? 'Za mało PLN na depozyt' : 'Za mało środków');
  }
  acc.orders.push(o);
  return o;
}

export function cancelOrder(acc, id, now = Date.now()) {
  const o = acc.orders.find((x) => x.id === id && x.status === 'open');
  if (!o) throw new Error('Nie ma takiego otwartego zlecenia');
  return reject(o, 'Anulowane przez Ciebie', now);
}

// Unrealised result in PLN, valued at the price the position would close at.
export function positionPnl(p, q, rate) {
  const exit = p.side === 'long' ? q.bid : q.ask;
  return { exit, pnl: (p.side === 'long' ? exit - p.entry : p.entry - exit) * p.amount * rate(p.symbol.split('_')[1]) };
}

function settle(acc, p, q, rate, now, status, reason = 'manual') {
  const { exit, pnl } = positionPnl(p, q, rate);
  const fee = p.amount * exit * rate(p.symbol.split('_')[1]) * MARGIN_FEE;
  const back = Math.max(0, p.margin + pnl - fee); // negative balance protection: you never lose more than the margin
  acc.balances[ACCOUNT] = round((acc.balances[ACCOUNT] || 0) + back);
  return Object.assign(p, { status, reason, exit, closeFee: round(fee), pnl: round(back - p.margin - p.fee), closedAt: now });
}

export function closePosition(acc, id, q, rate, now = Date.now()) {
  const p = acc.positions.find((x) => x.id === id && x.status === 'open');
  if (!p) throw new Error('Nie ma takiej otwartej pozycji');
  if (!q || !Number.isFinite(rate(p.symbol.split('_')[1]))) throw new Error('Brak notowań dla tej pary');
  return settle(acc, p, q, rate, now, 'closed');
}

const triggered = (o, q) =>
  o.side === 'buy'
    ? o.type === 'limit' ? q.ask <= o.price : q.ask >= o.price
    : o.type === 'limit' ? q.bid >= o.price : q.bid <= o.price;

// Called on every quote: fills triggered orders, then closes positions at their stop loss, take profit or close-out level.
export function matchOrders(acc, symbol, q, rate = noRate, now = Date.now()) {
  const orders = acc.orders
    .filter((o) => o.status === 'open' && o.symbol === symbol && triggered(o, q))
    .map((o) => fill(acc, o, q, rate, now));
  const positions = [];
  for (const p of acc.positions) {
    if (p.status !== 'open' || p.symbol !== symbol) continue;
    const { exit, pnl } = positionPnl(p, q, rate);
    const long = p.side === 'long';
    if (p.sl != null && (long ? exit <= p.sl : exit >= p.sl)) positions.push(settle(acc, p, q, rate, now, 'closed', 'sl'));
    else if (p.tp != null && (long ? exit >= p.tp : exit <= p.tp)) positions.push(settle(acc, p, q, rate, now, 'closed', 'tp'));
    else if (p.margin + pnl <= p.margin * CLOSE_OUT) positions.push(settle(acc, p, q, rate, now, 'liquidated', 'margin'));
  }
  return { orders, positions };
}

// Sets or clears (empty value) the stop loss and take profit of an open position, checked against its current exit price.
export function protectPosition(acc, id, input, q) {
  const p = acc.positions.find((x) => x.id === id && x.status === 'open');
  if (!p) throw new Error('Nie ma takiej otwartej pozycji');
  if (!q) throw new Error('Brak notowań dla tej pary');
  const long = p.side === 'long';
  return Object.assign(p, protection(long, long ? q.bid : q.ask, input));
}
