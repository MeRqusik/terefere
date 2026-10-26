import { createChart, CandlestickSeries, HistogramSeries, AreaSeries, LineStyle, CrosshairMode, ColorType } from '/vendor/lightweight-charts.mjs';
import { addTick } from '/candles.js';

const $ = (id) => document.getElementById(id);
const GREEN = '#1ee86f';
const RED = '#f4544a';
const AMBER = '#f6b941';
const BLUE = '#8fb3ff';
const CCY = {
  PLN: ['Złoty polski', 'zł', '#b0254f'],
  USD: ['Dolar amerykański', '$', '#2f9e6e'],
  EUR: ['Euro', '€', '#2f5fd0'],
  GBP: ['Funt brytyjski', '£', '#7c4ddb'],
  JPY: ['Jen japoński', '¥', '#c2417a'],
  CHF: ['Frank szwajcarski', 'Fr', '#d14343'],
  AUD: ['Dolar australijski', 'A$', '#d98a1c'],
  CAD: ['Dolar kanadyjski', 'C$', '#c0563b'],
  NZD: ['Dolar nowozelandzki', 'N$', '#1f8f99'],
};
const KIND = { market: 'Rynkowe', limit: 'Limit', stop: 'Stop' };
const RANGES = ['1D', '7D', '1M', '3M', '1Y'];

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  pairs: [], quotes: {}, stats: {}, account: null, market: { mode: 'live', volatility: 1 },
  rules: { account: 'PLN', fee: 0.001, marginFee: 0.0001, maxLeverage: 100, closeOut: 0.5 },
  symbol: store.get('symbol', 'EUR_PLN'), range: store.get('range', '1D'), display: store.get('display', 'PLN'),
  tab: store.get('tab', 'positions'), kind: store.get('kind', 'spot'), leverage: Number(store.get('leverage', 10)) || 10,
  view: 'chart', style: 'candle', side: 'buy', type: 'market', notes: [],
};
if (!RANGES.includes(S.range)) S.range = '1D';

// Formatting
const fmts = {};
const fmt = (x, d = 2) => (fmts[d] ??= new Intl.NumberFormat('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d })).format(x);
const compact = new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 });
const digits = (s) => (s.endsWith('JPY') ? 3 : 5);
const money = (x, c) => `${fmt(x, c === 'JPY' ? 0 : 2)} ${c}`;
const pctFmt = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 });
const pct = (x) => `${pctFmt.format(x * 100)}%`;
const sign = (x) => (x > 0 ? '+' : '');
const tone = (x) => (x >= 0 ? 'up' : 'down');
const mid = (q) => (q.bid + q.ask) / 2;
const label = (s) => s.replace('_', '/');
const names = (s) => s.split('_').map((c) => CCY[c][0]).join(' / ');
const parse = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));
const inputNum = (x, d) => fmt(x, d).replace(/\s/g, '');
const coin = (c, cls = '') => `<span class="coin ${cls}" style="background:${CCY[c][2]}">${CCY[c][1]}</span>`;
const coins = (s, cls = '') => `<span class="coins ${cls}">${s.split('_').map((c) => coin(c)).join('')}</span>`;
const time = (t) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function usd(c) {
  if (c === 'USD') return 1;
  const a = S.quotes[`${c}_USD`];
  const b = S.quotes[`USD_${c}`];
  return a ? mid(a) : b ? 1 / mid(b) : NaN;
}
const convert = (x, from, to) => (x * usd(from)) / usd(to);
const toAccount = (x, c) => convert(x, c, S.rules.account);

// Leveraged positions, valued the same way as server/exchange.js.
const dir = (p) => (p.side === 'long' ? 1 : -1);
const sideWord = (o) => (o.leverage ? `${o.side === 'buy' ? 'Long' : 'Short'} ${o.leverage}×` : o.side === 'buy' ? 'Kupno' : 'Sprzedaż');
const liqPrice = (p) => p.entry * (1 - (dir(p) * (1 - S.rules.closeOut)) / p.leverage);
function livePnl(p) {
  const q = S.quotes[p.symbol];
  if (!q) return null;
  const exit = p.side === 'long' ? q.bid : q.ask;
  return { exit, pnl: (exit - p.entry) * dir(p) * p.amount * toAccount(1, p.symbol.split('_')[1]) };
}

// Live data arrives 4× a second; DOM work is batched to one pass per frame.
const queued = new Set();
function later(fn) {
  if (!queued.size) requestAnimationFrame(() => { const fns = [...queued]; queued.clear(); fns.forEach((f) => f()); });
  queued.add(fn);
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json' } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Błąd serwera (${r.status})`);
  return data;
}

function toast(text, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 5000);
  S.notes.unshift({ text, at: Date.now() });
  S.notes.length = Math.min(S.notes.length, 20);
  $('bell').querySelector('.dot').hidden = false;
}

function describe(o) {
  const [base, quote] = o.symbol.split('_');
  return `${sideWord(o).toLowerCase()} ${fmt(o.amount)} ${base} po ${fmt(o.fillPrice ?? o.price, digits(o.symbol))} ${quote}`;
}

// Chart
const TZ = -new Date().getTimezoneOffset() * 60; // shortcut: one offset for all candles, an hour off across a DST change; fine for a chart
const chart = createChart($('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#7c7d84', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
  grid: { vertLines: { visible: false }, horzLines: { color: '#26272c', style: LineStyle.Dashed } },
  leftPriceScale: { visible: true, borderVisible: false },
  rightPriceScale: { visible: false },
  timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, lockVisibleTimeRangeOnResize: true },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: '#4a4b52', labelBackgroundColor: '#2c2d31' },
    horzLine: { color: '#4a4b52', labelBackgroundColor: '#2c2d31' },
  },
  localization: { locale: 'pl-PL' },
});
const candleSeries = chart.addSeries(CandlestickSeries, { priceScaleId: 'left', upColor: GREEN, downColor: RED, borderVisible: false, wickUpColor: GREEN, wickDownColor: RED });
const lineSeries = chart.addSeries(AreaSeries, { priceScaleId: 'left', lineColor: GREEN, topColor: 'rgba(30,232,111,.22)', bottomColor: 'rgba(30,232,111,0)', lineWidth: 2, visible: false });
const volSeries = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });

let bars = [];
let step = 300;
let loadSeq = 0;
const ohlc = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
const volBar = (b) => ({ time: b.time, value: b.trades, color: b.close >= b.open ? 'rgba(30,232,111,.2)' : 'rgba(244,84,74,.2)' });
function chartMsg(text, loading = false) {
  $('chartMsg').hidden = !text;
  $('chartMsg').textContent = text;
  $('chartMsg').classList.toggle('loading', loading);
}

async function loadChart() {
  const seq = ++loadSeq;
  const d = digits(S.symbol);
  const priceFormat = { type: 'price', precision: d, minMove: 10 ** -d };
  candleSeries.applyOptions({ priceFormat });
  lineSeries.applyOptions({ priceFormat });
  chartMsg('Ładowanie wykresu…', true);
  bars = []; // ticks of the new pair must not land on the old pair's candles
  try {
    const r = await api(`/api/candles?symbol=${S.symbol}&range=${S.range}`);
    if (seq !== loadSeq) return;
    step = r.step;
    bars = r.candles.map((c) => ({ ...c, time: c.time + TZ }));
    candleSeries.setData(bars.map(ohlc));
    lineSeries.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    volSeries.setData(bars.map(volBar));
    chart.timeScale().fitContent();
    chartMsg(bars.length ? '' : 'Brak notowań w tym zakresie');
  } catch (e) {
    if (seq === loadSeq) chartMsg(`Nie udało się pobrać historii: ${e.message}`);
  }
}

function tickChart(q) {
  const last = bars.length && addTick(bars, step, Math.floor(q.ts / 1000) + TZ, mid(q));
  if (!last) return;
  candleSeries.update(ohlc(last));
  lineSeries.update({ time: last.time, value: last.close });
  volSeries.update(volBar(last));
}

// Entry, liquidation and pending-order prices of the shown pair, drawn on the chart.
let lines = [];
function drawLines() {
  for (const [series, line] of lines) series.removePriceLine(line);
  lines = [];
  const a = S.account;
  if (!a) return;
  const series = S.style === 'candle' ? candleSeries : lineSeries;
  const add = (price, color, title, lineStyle = LineStyle.Dashed) =>
    lines.push([series, series.createPriceLine({ price, color, title, lineStyle, lineWidth: 1, axisLabelVisible: true })]);
  for (const p of a.positions) {
    if (p.status !== 'open' || p.symbol !== S.symbol) continue;
    add(p.entry, p.side === 'long' ? GREEN : RED, `${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}×`, LineStyle.Solid);
    add(liqPrice(p), AMBER, 'Likwidacja');
  }
  for (const o of a.orders) if (o.status === 'open' && o.symbol === S.symbol) add(o.price, BLUE, `${KIND[o.type]} · ${sideWord(o).toLowerCase()}`);
}

// Order book: the free LSE plan has no forex depth, so liquidity around the live bid/ask is simulated.
const bookSizes = new Map();
function renderBook() {
  const q = S.quotes[S.symbol];
  if (S.view !== 'book' || !q) return;
  const d = digits(S.symbol);
  const tick = (S.symbol.endsWith('JPY') ? 0.01 : 0.0001) / 2;
  if (bookSizes.size > 3000) bookSizes.clear();
  const side = (name, best, way) => {
    let cum = 0;
    return Array.from({ length: 12 }, (_, i) => {
      const price = best + way * i * tick;
      const key = name + price.toFixed(d + 1);
      if (!bookSizes.has(key)) bookSizes.set(key, Math.round((0.15 + Math.random()) * (1 + i * 0.4) * 4e5));
      cum += bookSizes.get(key);
      return { price, size: bookSizes.get(key), cum };
    });
  };
  const bids = side('b', q.bid, -1);
  const asks = side('a', q.ask, 1);
  const max = Math.max(bids.at(-1).cum, asks.at(-1).cum);
  const [base] = S.symbol.split('_');
  const rows = (list, cls) => list.map((r) =>
    `<div class="book-row"><i class="bar" style="width:${((r.cum / max) * 100).toFixed(1)}%"></i><span class="${cls}">${fmt(r.price, d)}</span><span>${compact.format(r.size)}</span><span>${compact.format(r.cum)}</span></div>`).join('');
  $('book').innerHTML = `
    <div class="book-side bids"><header><span>Kupujący (bid)</span><span>Ilość ${base}</span><span>Łącznie</span></header>${rows(bids, 'up')}</div>
    <div class="book-side asks"><header><span>Sprzedający (ask)</span><span>Ilość ${base}</span><span>Łącznie</span></header>${rows(asks, 'down')}</div>
    <p class="book-note">Najlepsze ceny pochodzą z notowań, głębokość arkusza jest symulowana.</p>`;
}

// Pair strip
const chips = {};
function buildStrip() {
  $('strip').innerHTML = S.pairs.map((s) =>
    `<button type="button" class="chip" data-sym="${s}" aria-pressed="${s === S.symbol}" title="${names(s)}">${coins(s, 'sm')}<b>${label(s)}</b><span class="px"><span>—</span><span></span></span></button>`).join('');
  for (const el of $('strip').children) {
    const [px, ch] = el.querySelectorAll('.px span');
    chips[el.dataset.sym] = { el, px, ch };
  }
  S.pairs.forEach(updateChip);
}
function updateChip(s) {
  const c = chips[s];
  const q = S.quotes[s];
  const st = S.stats[s];
  if (!c || !q) return;
  c.px.textContent = fmt(mid(q), digits(s));
  if (!st) return;
  const ch = (mid(q) / st.open - 1) * 100;
  c.ch.textContent = `${sign(ch)}${fmt(ch)}%`;
  c.ch.className = tone(ch);
}

// Ticker
let prevMid = null;
function renderTicker() {
  const s = S.symbol;
  const q = S.quotes[s];
  const st = S.stats[s];
  if (!q) return;
  const d = digits(s);
  const m = mid(q);
  if (prevMid !== null && m !== prevMid) $('price').className = `price ${m > prevMid ? 'up' : 'down'}`;
  prevMid = m;
  $('price').textContent = fmt(m, d);
  $('bid').textContent = fmt(q.bid, d);
  $('ask').textContent = fmt(q.ask, d);
  $('spread').textContent = `${fmt((q.ask - q.bid) / (s.endsWith('JPY') ? 0.01 : 0.0001), 1)} pip`;
  document.title = `${label(s)} ${fmt(m, d)} · terefere`;
  if (!st) return;
  const ch = m - st.open;
  $('change').innerHTML = `<span class="${tone(ch)}">${sign(ch)}${fmt(ch, d)}</span><span class="${tone(ch)}">${sign(ch)}${fmt((ch / st.open) * 100)}%</span>`;
  $('hilo').textContent = `${fmt(Math.min(st.low, m), d)} – ${fmt(Math.max(st.high, m), d)}`;
}

function pairRows(filter) {
  const norm = (x) => x.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, '');
  const f = norm(filter);
  const list = S.pairs.filter((s) => !f || norm(s).includes(f) || norm(names(s)).includes(f));
  if (!list.length) return '<div class="empty">Nic nie znaleziono</div>';
  return list.map((s) => {
    const q = S.quotes[s];
    const st = S.stats[s];
    const ch = q && st ? (mid(q) / st.open - 1) * 100 : null;
    return `<button type="button" class="row ${s === S.symbol ? 'on' : ''}" data-sym="${s}">${coins(s)}<span><b>${label(s)}</b><small>${names(s)}</small></span><span class="num">${q ? fmt(mid(q), digits(s)) : '—'}</span><span class="num ${tone(ch)}">${ch === null ? '' : `${sign(ch)}${fmt(ch)}%`}</span></button>`;
  }).join('');
}

// Order form
function formState() {
  const s = S.symbol;
  const [base, quote] = s.split('_');
  const q = S.quotes[s];
  const margin = S.kind === 'margin';
  const price = S.type === 'market' ? (q ? (S.side === 'buy' ? q.ask : q.bid) : NaN) : parse($('priceIn').value);
  return { s, base, quote, q, margin, price, amount: parse($('amountIn').value), lev: margin ? S.leverage : null };
}
const payCurrency = (f) => (f.margin ? S.rules.account : S.side === 'buy' ? f.quote : f.base);

function renderForm() {
  const f = formState();
  const R = S.rules;
  const A = R.account;
  const d = digits(f.s);
  const buy = S.side === 'buy';
  const [buyBtn, sellBtn] = document.querySelectorAll('[data-side] span');
  buyBtn.textContent = f.margin ? 'Long' : 'Kup';
  sellBtn.textContent = f.margin ? 'Short' : 'Sprzedaj';
  $('levBlock').hidden = !f.margin;
  $('levOut').textContent = `${S.leverage}×`;
  document.querySelectorAll('[data-lev]').forEach((b) => b.classList.toggle('on', Number(b.dataset.lev) === S.leverage));
  $('priceIn').disabled = S.type === 'market';
  $('priceLabel').textContent = S.type === 'market' ? 'Cena rynkowa' : S.type === 'limit' ? 'Cena limitu' : 'Cena aktywacji (stop)';
  if (S.type === 'market') $('priceIn').value = f.q ? fmt(f.price, d) : '';
  $('amountCcy').textContent = f.base;
  $('priceCcy').textContent = f.quote;
  const pay = payCurrency(f);
  $('availLabel').textContent = f.margin ? 'Wolne na depozyt' : 'Dostępne';
  $('avail').textContent = money(S.account?.available[pay] ?? 0, pay);

  const ok = f.amount > 0 && f.price > 0;
  const value = f.amount * f.price;
  const show = (x, c) => (ok ? money(x, c) : '—');
  let rows;
  if (f.margin) {
    const valueA = toAccount(value, f.quote);
    const liq = f.price * (1 - ((buy ? 1 : -1) * (1 - R.closeOut)) / f.lev);
    rows = [
      ['Kurs', f.price > 0 ? `${fmt(f.price, d)} ${f.quote}` : '—'],
      ['Wartość pozycji', f.quote === A ? show(value, A) : ok ? `${money(value, f.quote)} ≈ ${money(valueA, A)}` : '—'],
      ['Depozyt', show(valueA / f.lev, A)],
      [`Prowizja ${pct(R.marginFee)}`, show(valueA * R.marginFee, A)],
      ['Cena likwidacji', ok ? `≈ ${fmt(liq, d)}` : '—', 'warn'],
    ];
  } else {
    const fee = value * R.fee;
    rows = [
      ['Kurs', f.price > 0 ? `${fmt(f.price, d)} ${f.quote}` : '—'],
      ['Wartość', show(value, f.quote)],
      [`Prowizja ${pct(R.fee)}`, show(fee, f.quote)],
      [buy ? 'Zapłacisz' : 'Otrzymasz', show(buy ? value + fee : value - fee, f.quote)],
    ];
  }
  $('summary').innerHTML = rows.map(([k, v, cls]) => `<div class="${cls ?? ''}"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('submit').textContent = f.margin ? `Otwórz ${buy ? 'long' : 'short'} ${f.lev}× ${label(f.s)}` : `${buy ? 'Kup' : 'Sprzedaj'} ${f.base}`;
  $('submit').classList.toggle('sell', !buy);
  $('hint').textContent = f.margin
    ? `Zysk i strata liczone w ${A}. Pozycja zamknie się sama, gdy strata sięgnie ${pct(1 - R.closeOut)} depozytu. Nie stracisz więcej niż depozyt.`
    : '';
}

function prefillPrice() {
  const q = S.quotes[S.symbol];
  if (S.type !== 'market' && q) $('priceIn').value = inputNum(S.side === 'buy' ? q.ask : q.bid, digits(S.symbol));
}

// Activity: positions, pending orders, history
const emptyCard = (title, text) => `<div class="card empty"><b>${title}</b>${text}</div>`;

function posMeter(p) {
  const r = livePnl(p);
  if (!r) return '';
  const R = S.rules;
  const roe = (r.pnl / p.margin) * 100;
  const room = Math.max(0, Math.min(1, (r.pnl + p.margin * (1 - R.closeOut)) / (p.margin * (1 - R.closeOut))));
  const color = r.pnl >= 0 ? GREEN : room > 0.5 ? AMBER : RED;
  return `<div class="nums"><b class="${tone(r.pnl)}">${sign(r.pnl)}${money(r.pnl, R.account)}</b><span class="${tone(roe)}">${sign(roe)}${fmt(roe)}% depozytu</span></div>
    <div class="track"><i style="width:${(room * 100).toFixed(1)}%;background:${color}"></i></div>
    <div class="cap"><span>Zapas do likwidacji ${fmt(room * 100, 0)}%</span><span>Teraz ${fmt(r.exit, digits(p.symbol))}</span></div>`;
}

function posCard(p) {
  const [base] = p.symbol.split('_');
  const d = digits(p.symbol);
  return `<article class="card pos" data-pos="${p.id}">
    <div class="head">${coins(p.symbol)}${label(p.symbol)}<span class="badge ${p.side}">${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}×</span><time>${time(p.openedAt)}</time><button type="button" class="btn-ghost" data-close="${p.id}">Zamknij</button></div>
    <dl class="cols">
      <div><dt>Wielkość (${base})</dt><dd>${fmt(p.amount)}</dd></div>
      <div><dt>Cena wejścia</dt><dd>${fmt(p.entry, d)}</dd></div>
      <div><dt>Depozyt</dt><dd>${money(p.margin, S.rules.account)}</dd></div>
      <div><dt>Likwidacja ≈</dt><dd class="liq">${fmt(liqPrice(p), d)}</dd></div>
    </dl>
    <div class="meter">${posMeter(p)}</div>
  </article>`;
}

function orderNow(o) {
  const q = S.quotes[o.symbol];
  if (!q) return ['—', '—'];
  const now = o.side === 'buy' ? q.ask : q.bid;
  const dist = (o.price / now - 1) * 100;
  return [fmt(now, digits(o.symbol)), `${sign(dist)}${fmt(dist)}%`];
}

function ordersTable(list) {
  return `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Para</th><th>Typ</th><th>Strona</th><th class="n">Ilość</th><th class="n">Cena</th><th class="n">Teraz</th><th class="n">Do aktywacji</th><th></th></tr></thead><tbody>
    ${list.map((o) => {
      const [now, dist] = orderNow(o);
      return `<tr data-order="${o.id}"><td><span class="pair">${coins(o.symbol, 'sm')}${label(o.symbol)}</span></td><td>${KIND[o.type]}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${sideWord(o)}</td><td class="n">${fmt(o.amount)} ${o.symbol.split('_')[0]}</td><td class="n">${fmt(o.price, digits(o.symbol))}</td><td class="n" data-now>${now}</td><td class="n" data-dist>${dist}</td><td class="n"><button type="button" class="btn-ghost" data-cancel="${o.id}">Anuluj</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function historyTable(a, mine) {
  const A = S.rules.account;
  const items = [
    ...a.orders.filter((o) => mine(o) && (o.status === 'cancelled' || (o.status === 'filled' && !o.leverage))).map((o) => ({ at: o.closedAt ?? o.createdAt, o })),
    ...a.positions.filter((p) => mine(p) && p.status !== 'open').map((p) => ({ at: p.closedAt, p })),
  ].sort((x, y) => y.at - x.at).slice(0, 60);
  if (!items.length) return emptyCard('Historia jest pusta', 'Tu pojawią się wymiany walut, zamknięte pozycje i anulowane zlecenia.');
  const row = ({ at, o, p }) => {
    const s = (o ?? p).symbol;
    const [base, quote] = s.split('_');
    const d = digits(s);
    let what;
    let price;
    let result;
    if (p) {
      what = `<span class="badge ${p.side}">${p.side === 'long' ? 'Long' : 'Short'} ${p.leverage}×</span> ${p.status === 'liquidated' ? '<span class="badge liquidated">Likwidacja</span>' : 'zamknięta'}`;
      price = `${fmt(p.entry, d)} → ${fmt(p.exit, d)}`;
      result = `<span class="${tone(p.pnl)}">${sign(p.pnl)}${money(p.pnl, A)}</span>`;
    } else if (o.status === 'filled') {
      what = `<span class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Kupno' : 'Sprzedaż'}</span> <span class="muted">${KIND[o.type].toLowerCase()}</span>`;
      price = fmt(o.fillPrice, d);
      result = money(o.amount * o.fillPrice, quote);
    } else {
      what = `<span class="muted">Anulowane · ${KIND[o.type].toLowerCase()} ${sideWord(o).toLowerCase()}</span>`;
      price = fmt(o.price, d);
      result = `<small>${o.reason ?? ''}</small>`;
    }
    return `<tr><td>${time(at)}</td><td><span class="pair">${coins(s, 'sm')}${label(s)}</span></td><td>${what}</td><td class="n">${fmt((o ?? p).amount)} ${base}</td><td class="n">${price}</td><td class="n">${result}</td></tr>`;
  };
  return `<div class="card table-wrap"><table class="tbl"><thead><tr><th>Czas</th><th>Para</th><th>Operacja</th><th class="n">Ilość</th><th class="n">Cena</th><th class="n">Wynik / wartość</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table></div>`;
}

function renderActivity() {
  const a = S.account;
  if (!a) return;
  const only = $('onlyPair').checked;
  const mine = (x) => !only || x.symbol === S.symbol;
  const positions = a.positions.filter((p) => p.status === 'open' && mine(p)).reverse();
  const orders = a.orders.filter((o) => o.status === 'open' && mine(o)).reverse();
  $('cPositions').textContent = positions.length;
  $('cOrders').textContent = orders.length;
  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === S.tab);
    b.setAttribute('aria-selected', b.dataset.tab === S.tab);
  });
  $('activityBody').innerHTML =
    S.tab === 'positions'
      ? positions.length ? `<div class="list">${positions.map(posCard).join('')}</div>` : emptyCard('Brak otwartych pozycji', 'Przełącz panel zlecenia na „Dźwignia”, aby zarabiać na wzroście (long) albo spadku (short) kursu, z depozytem w PLN.')
      : S.tab === 'orders'
        ? orders.length ? ordersTable(orders) : emptyCard('Brak oczekujących zleceń', 'Zlecenie Limit albo Stop wykona się samo, gdy kurs dojdzie do podanej ceny.')
        : historyTable(a, mine);
}

// Live values inside the activity list, updated in place so buttons keep focus.
function updateLive() {
  if (!S.account) return;
  for (const el of $('activityBody').querySelectorAll('[data-pos]')) {
    const p = S.account.positions.find((x) => x.id === Number(el.dataset.pos));
    if (p) el.querySelector('.meter').innerHTML = posMeter(p);
  }
  for (const el of $('activityBody').querySelectorAll('[data-order]')) {
    const o = S.account.orders.find((x) => x.id === Number(el.dataset.order));
    if (!o) continue;
    const [now, dist] = orderNow(o);
    el.querySelector('[data-now]').textContent = now;
    el.querySelector('[data-dist]').textContent = dist;
  }
}

// Account
function renderAccount() {
  const a = S.account;
  if (!a) return;
  const D = S.display;
  const A = S.rules.account;
  const rows = Object.entries(a.balances).filter(([, v]) => Math.abs(v) > 1e-9).sort((x, y) => convert(y[1], y[0], D) - convert(x[1], x[0], D));
  $('walletRows').innerHTML = rows.map(([c, v]) => {
    const held = v - (a.available[c] ?? v);
    const sub = [c !== D ? `≈ ${money(convert(v, c, D), D)}` : '', held > 1e-9 ? `${money(held, c)} w zleceniach` : ''].filter(Boolean);
    return `<div><dt>${coin(c, 'sm')}${c}</dt><dd>${money(v, c)}${sub.map((x) => `<small>${x}</small>`).join('')}</dd></div>`;
  }).join('') || '<div><dt>Brak środków</dt></div>';
  const open = a.positions.filter((p) => p.status === 'open');
  let margin = 0;
  let upnl = 0;
  for (const p of open) {
    margin += p.margin;
    upnl += livePnl(p)?.pnl ?? 0;
  }
  $('marginBox').hidden = !open.length;
  $('mMargin').textContent = money(margin, A);
  $('mPnl').innerHTML = `<span class="${tone(upnl)}">${sign(upnl)}${money(upnl, A)}</span>`;
  const total = rows.reduce((s, [c, v]) => s + convert(v, c, D), 0) + convert(margin + upnl, A, D);
  const start = Object.entries(a.start).reduce((s, [c, v]) => s + convert(v, c, D), 0);
  if (!Number.isFinite(total)) return;
  const pnl = total - start;
  $('wTotal').textContent = money(total, D);
  $('total').textContent = money(total, D);
  $('wPnl').innerHTML = `<span class="${tone(pnl)}">${sign(pnl)}${money(pnl, D)} (${sign(pnl)}${fmt((pnl / start) * 100)}%)</span> <span class="muted">od startu</span>`;
}

function renderMode() {
  const sim = S.market.mode === 'sim';
  document.querySelectorAll('.mode [data-mode]').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === S.market.mode);
    b.setAttribute('aria-pressed', b.dataset.mode === S.market.mode);
  });
  $('volatility').hidden = !sim;
  $('volatility').value = S.market.volatility;
  $('railSim').classList.toggle('on', sim);
  $('modeTag').textContent = sim ? `Symulacja · zmienność ${S.market.volatility}×` : 'Na żywo · LSE';
  $('modeTag').classList.toggle('sim', sim);
}

function selectPair(s, chartToo = true) {
  S.symbol = s;
  store.set('symbol', s);
  bookSizes.clear();
  prevMid = null;
  for (const [k, c] of Object.entries(chips)) c.el.setAttribute('aria-pressed', k === s);
  chips[s]?.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('pairCoins').innerHTML = coins(s);
  $('pairName').textContent = label(s);
  $('pairLong').textContent = names(s);
  $('price').className = 'price';
  $('searchList').hidden = true;
  $('search').value = '';
  prefillPrice();
  renderTicker();
  renderForm();
  renderActivity();
  renderBook();
  drawLines();
  if (chartToo) loadChart();
}

async function setMode(mode, volatility = S.market.volatility) {
  try {
    S.market = await api('/api/market', { method: 'POST', body: JSON.stringify({ mode, volatility }) });
    renderMode();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function refresh() {
  const st = await api('/api/state');
  const wasMode = S.market.mode;
  Object.assign(S, { pairs: st.pairs, quotes: st.quotes, stats: st.stats, account: st.account, market: st.market, rules: st.rules });
  if (!S.pairs.includes(S.symbol)) {
    S.symbol = S.pairs[0];
    loadChart();
  }
  $('ranges').innerHTML = st.ranges.map((r) => `<button type="button" data-range="${r}" class="${r === S.range ? 'on' : ''}" aria-pressed="${r === S.range}">${r}</button>`).join('');
  $('levIn').max = S.rules.maxLeverage;
  buildStrip();
  if (Object.keys(S.stats).length < S.pairs.length) setTimeout(() => refresh().catch(() => {}), 3000); // server still warming up
  renderMode();
  renderAccount();
  renderActivity();
  renderTicker();
  renderForm();
  drawLines();
  if (wasMode !== S.market.mode) loadChart();
}

// Events
const pick = (sel, key, fn) => document.querySelectorAll(sel).forEach((b) => (b.onclick = () => {
  document.querySelectorAll(sel).forEach((x) => {
    x.classList.toggle('on', x === b);
    x.setAttribute(x.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-pressed', x === b);
  });
  fn(b.dataset[key]);
}));

document.addEventListener('click', (e) => {
  for (const [id, trigger] of [['searchList', '.search'], ['notes', '#bell']]) {
    if (!$(id).hidden && !e.target.closest(`#${id}`) && !e.target.closest(trigger)) $(id).hidden = true;
  }
  const row = e.target.closest('[data-sym]');
  if (row) selectPair(row.dataset.sym);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, select, textarea')) {
    e.preventDefault();
    $('search').focus();
  }
});
$('search').oninput = () => {
  $('searchList').innerHTML = pairRows($('search').value);
  $('searchList').hidden = false;
};
$('search').onfocus = $('search').oninput;
$('search').onkeydown = (e) => {
  if (e.key === 'Enter') $('searchList').querySelector('[data-sym]')?.click();
  if (e.key === 'Escape') { $('searchList').hidden = true; $('search').blur(); }
};
$('bell').onclick = () => {
  $('bell').querySelector('.dot').hidden = true;
  $('notes').innerHTML = S.notes.length
    ? S.notes.map((n) => `<div class="note"><b></b><time>${time(n.at)}</time></div>`).join('')
    : '<div class="empty">Brak powiadomień</div>';
  $('notes').querySelectorAll('.note b').forEach((b, i) => (b.textContent = S.notes[i].text));
  $('notes').hidden = !$('notes').hidden;
};
document.querySelectorAll('.mode [data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('volatility').onchange = () => setMode('sim', Number($('volatility').value));
$('railSim').onclick = () => setMode(S.market.mode === 'sim' ? 'live' : 'sim');
$('display').value = S.display;
$('display').onchange = () => {
  S.display = $('display').value;
  store.set('display', S.display);
  renderAccount();
};

$('ranges').onclick = (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  S.range = b.dataset.range;
  store.set('range', S.range);
  $('ranges').querySelectorAll('button').forEach((x) => {
    x.classList.toggle('on', x === b);
    x.setAttribute('aria-pressed', x === b);
  });
  loadChart();
};
pick('[data-view]', 'view', (v) => {
  S.view = v;
  $('chart').hidden = v !== 'chart';
  $('book').hidden = v !== 'book';
  $('styleSeg').hidden = v !== 'chart';
  renderBook();
});
pick('[data-style]', 'style', (v) => {
  S.style = v;
  candleSeries.applyOptions({ visible: v === 'candle' });
  lineSeries.applyOptions({ visible: v === 'line' });
  drawLines();
});
pick('[data-kind]', 'kind', (v) => {
  S.kind = v;
  store.set('kind', v);
  $('formErr').textContent = '';
  renderForm();
});
pick('[data-side]', 'side', (v) => {
  S.side = v;
  prefillPrice();
  renderForm();
});
pick('[data-type]', 'type', (v) => {
  S.type = v;
  prefillPrice();
  renderForm();
});
pick('[data-tab]', 'tab', (v) => {
  S.tab = v;
  store.set('tab', v);
  renderActivity();
});
// Restore the stored form kind and tab on the segmented controls.
document.querySelector(`[data-kind="${S.kind}"]`)?.click();
document.querySelector(`[data-tab="${S.tab}"]`)?.click();

$('levIn').value = S.leverage;
$('levIn').oninput = () => {
  S.leverage = Number($('levIn').value);
  store.set('leverage', S.leverage);
  renderForm();
};
document.querySelectorAll('[data-lev]').forEach((b) => (b.onclick = () => {
  $('levIn').value = b.dataset.lev;
  $('levIn').oninput();
}));
$('amountIn').oninput = renderForm;
$('priceIn').oninput = renderForm;
document.querySelectorAll('[data-pct]').forEach((b) => (b.onclick = () => {
  const f = formState();
  const R = S.rules;
  const have = S.account?.available[payCurrency(f)] ?? 0;
  const share = Number(b.dataset.pct) / 100;
  const amt = f.margin
    ? (have * f.lev) / (toAccount(f.price, f.quote) * (1 + f.lev * R.marginFee))
    : S.side === 'buy' ? have / (f.price * (1 + R.fee)) : have;
  if (!(amt > 0)) return;
  $('amountIn').value = inputNum(Math.floor(amt * share * 100) / 100, 2);
  renderForm();
}));

$('trade').onsubmit = async (e) => {
  e.preventDefault();
  const f = formState();
  $('formErr').textContent = '';
  if (!(f.amount > 0)) return ($('formErr').textContent = 'Podaj ilość większą od zera.');
  if (S.type !== 'market' && !(f.price > 0)) return ($('formErr').textContent = 'Podaj cenę zlecenia.');
  $('submit').disabled = true;
  try {
    const o = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ symbol: f.s, side: S.side, type: S.type, amount: f.amount, price: S.type === 'market' ? undefined : f.price, leverage: f.lev ?? undefined }),
    });
    if (o.status === 'filled') toast(o.leverage ? `Otwarto pozycję: ${describe(o)}` : `Zrealizowano: ${describe(o)}`);
    else toast(`Przyjęto zlecenie ${KIND[o.type]}: ${describe(o)}`);
    if (o.leverage && o.status === 'filled' && S.tab !== 'positions') document.querySelector('[data-tab="positions"]').click();
    if (o.status === 'open' && S.tab !== 'orders') document.querySelector('[data-tab="orders"]').click();
    $('amountIn').value = '';
  } catch (err) {
    $('formErr').textContent = err.message;
  } finally {
    $('submit').disabled = false;
    renderForm();
  }
};

$('onlyPair').onchange = renderActivity;
$('activityBody').onclick = async (e) => {
  const b = e.target.closest('[data-cancel], [data-close]');
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.cancel) {
      await api(`/api/orders/${b.dataset.cancel}`, { method: 'DELETE' });
      toast('Zlecenie anulowane');
    } else {
      const p = await api(`/api/positions/${b.dataset.close}/close`, { method: 'POST' });
      toast(`Zamknięto ${p.side} ${p.leverage}× ${label(p.symbol)}: ${sign(p.pnl)}${money(p.pnl, S.rules.account)}`, p.pnl >= 0 ? 'ok' : 'err');
    }
  } catch (err) {
    toast(err.message, 'err');
    b.disabled = false;
  }
};
$('reset').onclick = async () => {
  if (!confirm('Zacząć od nowa? Saldo wróci do 100 000 PLN, a zlecenia i pozycje zostaną usunięte.')) return;
  await api('/api/reset', { method: 'POST' }).catch((err) => toast(err.message, 'err'));
};

function connect() {
  const es = new EventSource('/api/stream');
  let opened = false;
  es.onopen = () => { if (opened) refresh().catch(() => {}); opened = true; };
  es.addEventListener('quotes', (e) => {
    const batch = JSON.parse(e.data);
    Object.assign(S.quotes, batch);
    for (const s of Object.keys(batch)) updateChip(s);
    const q = batch[S.symbol];
    if (q) {
      tickChart(q);
      later(renderTicker);
      later(renderBook);
      if (S.type === 'market') later(renderForm);
    }
    later(renderAccount);
    later(updateLive);
  });
  es.addEventListener('account', (e) => {
    S.account = JSON.parse(e.data);
    renderAccount();
    renderActivity();
    renderForm();
    drawLines();
  });
  es.addEventListener('order', (e) => {
    const o = JSON.parse(e.data);
    if (o.status === 'filled') toast(`${o.leverage ? 'Otwarto pozycję' : 'Zrealizowano zlecenie'} ${KIND[o.type]}: ${describe(o)}`);
    else toast(`Odrzucono zlecenie ${KIND[o.type]}: ${o.reason}`, 'err');
  });
  es.addEventListener('liquidation', (e) => {
    const p = JSON.parse(e.data);
    toast(`Likwidacja: ${p.side} ${p.leverage}× ${label(p.symbol)}, wynik ${money(p.pnl, S.rules.account)}`, 'err');
  });
  es.addEventListener('mode', (e) => {
    const was = S.market.mode;
    S.market = JSON.parse(e.data);
    renderMode();
    if (was !== S.market.mode) loadChart(); // drop simulated candles, or start the sim from fresh history
  });
  es.addEventListener('news', (e) => {
    const n = JSON.parse(e.data);
    const change = n.change * 100;
    toast(`Symulacja: ${CCY[n.currency][0]} ${change > 0 ? 'zyskuje' : 'traci'} ${fmt(Math.abs(change))}% wobec USD`, 'news');
  });
}

// The chart request starts right away, in parallel with the account state.
loadChart();
refresh()
  .then(() => selectPair(S.symbol, false))
  .catch((e) => chartMsg(`Serwer nie odpowiada: ${e.message}`))
  .finally(connect);
