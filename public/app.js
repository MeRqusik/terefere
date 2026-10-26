import { createChart, CandlestickSeries, HistogramSeries, AreaSeries, LineStyle, CrosshairMode, ColorType } from '/vendor/lightweight-charts.mjs';

const $ = (id) => document.getElementById(id);
const FEE = 0.001; // same as server/exchange.js
const GREEN = '#1ee86f';
const RED = '#f24b3f';
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
const STATUS = { open: 'Oczekujące', filled: 'Zrealizowane', cancelled: 'Anulowane' };
const KIND = { market: 'Rynkowe', limit: 'Limit', stop: 'Stop' };

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  pairs: [], quotes: {}, stats: {}, account: null, market: { mode: 'live', volatility: 1 },
  symbol: store.get('symbol', 'EUR_PLN'), range: store.get('range', '1D'), display: store.get('display', 'PLN'),
  view: 'chart', style: 'candle', side: 'buy', type: 'market', notes: [], unread: 0,
};

// Formatting
const fmts = {};
const fmt = (x, d = 2) => (fmts[d] ??= new Intl.NumberFormat('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d })).format(x);
const compact = new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 });
const digits = (s) => (s.endsWith('JPY') ? 3 : 5);
const money = (x, c) => `${fmt(x, c === 'JPY' ? 0 : 2)} ${c}`;
const sign = (x) => (x > 0 ? '+' : '');
const mid = (q) => (q.bid + q.ask) / 2;
const label = (s) => s.replace('_', '/');
const names = (s) => s.split('_').map((c) => CCY[c][0]).join(' / ');
const parse = (v) => Number(String(v).replace(/\s/g, '').replace(',', '.'));
const coin = (c, cls = '') => `<span class="coin ${cls}" style="background:${CCY[c][2]}">${CCY[c][1]}</span>`;
const coins = (s) => `<span class="coins">${s.split('_').map((c) => coin(c)).join('')}</span>`;
const time = (t) => new Date(t).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function usd(c) {
  if (c === 'USD') return 1;
  const a = S.quotes[`${c}_USD`];
  const b = S.quotes[`USD_${c}`];
  return a ? mid(a) : b ? 1 / mid(b) : NaN;
}
const convert = (x, from, to) => (x * usd(from)) / usd(to);

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
  S.unread++;
  $('bell').querySelector('.dot').hidden = false;
}

function describe(o) {
  const [base, quote] = o.symbol.split('_');
  return `${o.side === 'buy' ? 'kupno' : 'sprzedaż'} ${fmt(o.amount)} ${base} po ${fmt(o.fillPrice ?? o.price, digits(o.symbol))} ${quote}`;
}

// Chart
const TZ = -new Date().getTimezoneOffset() * 60; // shortcut: one offset for all candles, an hour off across a DST change; fine for a chart
const chart = createChart($('chart'), {
  autoSize: true,
  layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#7c7d84', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
  grid: { vertLines: { visible: false }, horzLines: { color: '#2a2b30', style: LineStyle.Dashed } },
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
const lineSeries = chart.addSeries(AreaSeries, { priceScaleId: 'left', lineColor: GREEN, topColor: 'rgba(30,232,111,.25)', bottomColor: 'rgba(30,232,111,0)', lineWidth: 2, visible: false });
const volSeries = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });

let bars = [];
let step = 300;
let loadSeq = 0;
const ohlc = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close });
const volBar = (b) => ({ time: b.time, value: b.trades, color: b.close >= b.open ? 'rgba(30,232,111,.22)' : 'rgba(242,75,63,.22)' });
const chartMsg = (text) => { $('chartMsg').hidden = !text; $('chartMsg').textContent = text; };

async function loadChart() {
  const seq = ++loadSeq;
  const d = digits(S.symbol);
  const priceFormat = { type: 'price', precision: d, minMove: 10 ** -d };
  candleSeries.applyOptions({ priceFormat });
  lineSeries.applyOptions({ priceFormat });
  chartMsg('Ładowanie notowań…');
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

// Live ticks extend the last candle, or open a new one on the series' own time grid.
function tickChart(q) {
  if (!bars.length) return;
  const t = Math.floor(q.ts / 1000) + TZ;
  const p = mid(q);
  let last = bars.at(-1);
  if (t < last.time) return;
  if (t >= last.time + step) {
    last = { time: last.time + Math.floor((t - last.time) / step) * step, open: p, high: p, low: p, close: p, trades: 0 };
    bars.push(last);
  }
  Object.assign(last, { high: Math.max(last.high, p), low: Math.min(last.low, p), close: p, trades: last.trades + 1 });
  candleSeries.update(ohlc(last));
  lineSeries.update({ time: last.time, value: p });
  volSeries.update(volBar(last));
}

// Order book: the free LSE plan has no forex depth, so liquidity around the live bid/ask is simulated.
const bookSizes = new Map();
function renderBook() {
  const q = S.quotes[S.symbol];
  if (S.view !== 'book' || !q) return;
  const d = digits(S.symbol);
  const tick = (S.symbol.endsWith('JPY') ? 0.01 : 0.0001) / 2;
  if (bookSizes.size > 3000) bookSizes.clear();
  const side = (name, best, dir) => {
    let cum = 0;
    return Array.from({ length: 12 }, (_, i) => {
      const price = best + dir * i * tick;
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
  const rows = (list, cls) =>
    list.map((r) => `<div class="book-row"><i class="bar" style="width:${((r.cum / max) * 100).toFixed(1)}%"></i><span class="${cls}">${fmt(r.price, d)}</span><span>${compact.format(r.size)}</span><span>${compact.format(r.cum)}</span></div>`).join('');
  $('book').innerHTML = `
    <div class="book-side bids"><header><span>Kupno (bid)</span><span>Ilość ${base}</span><span>Suma</span></header>${rows(bids, 'up')}</div>
    <div class="book-side asks"><header><span>Sprzedaż (ask)</span><span>Ilość ${base}</span><span>Suma</span></header>${rows(asks, 'down')}</div>
    <p class="book-note">Ceny najlepszych ofert pochodzą z notowań, głębokość arkusza jest symulowana.</p>`;
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
  const pip = s.endsWith('JPY') ? 0.01 : 0.0001;
  if (prevMid !== null && m !== prevMid) $('price').className = `price ${m > prevMid ? 'up' : 'down'}`;
  prevMid = m;
  $('price').textContent = fmt(m, d);
  $('bid').textContent = fmt(q.bid, d);
  $('ask').textContent = fmt(q.ask, d);
  document.title = `${label(s)} ${fmt(m, d)} · terefere`;
  if (!st) return;
  const ch = m - st.open24;
  const cls = ch >= 0 ? 'up' : 'down';
  $('change').innerHTML = `<span class="${cls}">${sign(ch)}${fmt(ch, d)}</span><span class="${cls}">${sign(ch)}${fmt((ch / st.open24) * 100)}%</span>`;
  $('hilo').textContent = `${fmt(Math.max(st.high24, m), d)} / ${fmt(Math.min(st.low24, m), d)}`;
  $('spread').textContent = `${fmt((q.ask - q.bid) / pip, 1)} pip / ${compact.format(st.trades24)}`;
}

function pairRows(filter) {
  const norm = (x) => x.toLowerCase().replace(/[^a-ząćęłńóśźż]/g, '');
  const f = norm(filter);
  const list = S.pairs.filter((s) => !f || norm(s).includes(f) || norm(names(s)).includes(f));
  if (!list.length) return '<div class="empty">Nic nie znaleziono</div>';
  return list.map((s) => {
    const q = S.quotes[s];
    const st = S.stats[s];
    const ch = q && st ? (mid(q) / st.open24 - 1) * 100 : null;
    return `<button type="button" class="row ${s === S.symbol ? 'on' : ''}" data-sym="${s}">${coins(s)}<span><b>${label(s)}</b><small>${names(s)}</small></span><span class="num">${q ? fmt(mid(q), digits(s)) : '—'}</span><span class="num ${ch >= 0 ? 'up' : 'down'}">${ch === null ? '' : `${sign(ch)}${fmt(ch)}%`}</span></button>`;
  }).join('');
}

// Order form
function formState() {
  const s = S.symbol;
  const [base, quote] = s.split('_');
  const q = S.quotes[s];
  const price = S.type === 'market' ? (q ? (S.side === 'buy' ? q.ask : q.bid) : NaN) : parse($('priceIn').value);
  return { s, base, quote, q, price, amount: parse($('amountIn').value) };
}

function renderForm() {
  const { s, base, quote, q, price, amount } = formState();
  const d = digits(s);
  const market = S.type === 'market';
  $('amountCcy').textContent = base;
  $('priceCcy').textContent = quote;
  $('priceIn').disabled = market;
  $('priceLabel').textContent = market ? 'Cena rynkowa' : S.type === 'limit' ? 'Cena limitu' : 'Cena aktywacji (stop)';
  if (market) $('priceIn').value = q ? fmt(price, d) : '';
  const pay = S.side === 'buy' ? quote : base;
  $('avail').textContent = money(S.account?.available[pay] ?? 0, pay);
  const ok = amount > 0 && price > 0;
  const value = amount * price;
  const fee = value * FEE;
  $('sumRate').textContent = price > 0 ? `${fmt(price, d)} ${quote}` : '—';
  $('sumValue').textContent = ok ? money(value, quote) : '—';
  $('sumFee').textContent = ok ? money(fee, quote) : '—';
  $('sumNetLabel').textContent = S.side === 'buy' ? 'Zapłacisz' : 'Otrzymasz';
  $('sumNet').textContent = ok ? money(S.side === 'buy' ? value + fee : value - fee, quote) : '—';
  $('submit').textContent = `${S.side === 'buy' ? 'Kup' : 'Sprzedaj'} ${base}`;
  $('submit').classList.toggle('sell', S.side === 'sell');
}

function prefillPrice() {
  const q = S.quotes[S.symbol];
  if (S.type !== 'market' && q) $('priceIn').value = fmt(S.side === 'buy' ? q.ask : q.bid, digits(S.symbol)).replace(/\s/g, '');
}

// Orders
function meter(o) {
  const q = S.quotes[o.symbol];
  const d = digits(o.symbol);
  const quote = o.symbol.split('_')[1];
  if (o.status === 'cancelled') return `<div class="cap"><span>${o.reason ?? ''}</span></div>`;
  if (!q) return '';
  if (o.status === 'filled') {
    const now = o.side === 'buy' ? q.bid : q.ask;
    const pnl = (o.side === 'buy' ? now - o.fillPrice : o.fillPrice - now) * o.amount - o.fee;
    const pct = (pnl / (o.amount * o.fillPrice)) * 100;
    const w = Math.min(Math.abs(pct) / 1, 1) * 50;
    return `<div class="nums"><span>${fmt(o.fillPrice, d)}</span><b class="${pnl >= 0 ? 'up' : 'down'}">${sign(pnl)}${money(pnl, quote)}</b><span>${fmt(now, d)}</span></div>
      <div class="track"><i style="left:${pnl >= 0 ? 50 : 50 - w}%;width:${w}%;background:${pnl >= 0 ? GREEN : RED}"></i></div>
      <div class="cap"><span>Wejście</span><span>Wynik ${sign(pct)}${fmt(pct)}%</span><span>Teraz</span></div>`;
  }
  const now = o.side === 'buy' ? q.ask : q.bid;
  const dist = (o.price / now - 1) * 100;
  const close = Math.max(0, 1 - Math.abs(dist) / 1) * 100;
  return `<div class="nums"><span>${fmt(now, d)}</span><b>${fmt(o.price, d)}</b></div>
    <div class="track"><i style="left:0;width:${close}%;background:#8fb3ff"></i></div>
    <div class="cap"><span>Teraz</span><span>Do aktywacji ${sign(dist)}${fmt(dist)}%</span></div>`;
}

function renderOrders() {
  if (!S.account) return;
  const f = $('orderFilter').value;
  const only = $('onlyPair').checked;
  const list = S.account.orders.filter((o) => (f === 'all' || o.status === f) && (!only || o.symbol === S.symbol)).reverse().slice(0, 60);
  $('orderList').innerHTML = list.length
    ? list.map((o) => {
      const [base, quote] = o.symbol.split('_');
      const px = o.fillPrice ?? o.price;
      return `<article class="card order" data-id="${o.id}">
        <div class="head">${coins(o.symbol)}${label(o.symbol)}<span class="badge ${o.status}">${STATUS[o.status]}</span><span class="badge cancelled">${KIND[o.type]}</span><time class="when">${time(o.closedAt ?? o.createdAt)}</time></div>
        <dl class="cols">
          <div><dt>Strona</dt><dd class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Kupno' : 'Sprzedaż'}</dd></div>
          <div><dt>Ilość (${base})</dt><dd>${fmt(o.amount)}</dd></div>
          <div><dt>${o.status === 'filled' ? 'Cena realizacji' : 'Cena zlecenia'}</dt><dd>${fmt(px, digits(o.symbol))}</dd></div>
          <div><dt>Wartość (${quote})</dt><dd>${fmt(o.amount * px)}</dd></div>
        </dl>
        <div class="meter">${meter(o)}</div>
        ${o.status === 'open' ? `<button class="act" data-cancel="${o.id}" aria-label="Anuluj zlecenie" title="Anuluj"><svg class="ico sm"><use href="#i-x"/></svg></button>` : ''}
      </article>`;
    }).join('')
    : '<div class="card empty-list">Brak zleceń. Złóż pierwsze w panelu po prawej.</div>';
}

function updateMeters() {
  if (!S.account) return;
  for (const el of $('orderList').querySelectorAll('.order')) {
    const o = S.account.orders.find((x) => x.id === Number(el.dataset.id));
    if (o && o.status !== 'cancelled') el.querySelector('.meter').innerHTML = meter(o);
  }
}

// Wallet
function renderWallet() {
  const a = S.account;
  if (!a) return;
  const D = S.display;
  const rows = Object.entries(a.balances).filter(([, v]) => Math.abs(v) > 1e-9).sort((x, y) => convert(y[1], y[0], D) - convert(x[1], x[0], D));
  $('walletRows').innerHTML = rows.map(([c, v]) => {
    const held = v - (a.available[c] ?? v);
    const sub = [c !== D ? `≈ ${money(convert(v, c, D), D)}` : '', held > 1e-9 ? `${money(held, c)} w zleceniach` : ''].filter(Boolean);
    return `<div><dt>${coin(c, 'sm')}${c}</dt><dd>${money(v, c)}${sub.map((x) => `<small>${x}</small>`).join('')}</dd></div>`;
  }).join('') || '<div><dt>Brak środków</dt></div>';
  const total = rows.reduce((s, [c, v]) => s + convert(v, c, D), 0);
  const start = Object.entries(a.start).reduce((s, [c, v]) => s + convert(v, c, D), 0);
  if (!Number.isFinite(total)) return;
  const pnl = total - start;
  $('wTotal').textContent = money(total, D);
  $('total').textContent = money(total, D);
  $('wPnl').innerHTML = `<span class="${pnl >= 0 ? 'up' : 'down'}">${sign(pnl)}${money(pnl, D)} (${sign(pnl)}${fmt((pnl / start) * 100)}%)</span>`;
}

function renderMode() {
  const sim = S.market.mode === 'sim';
  document.querySelectorAll('.mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.market.mode));
  $('volatility').hidden = !sim;
  $('volatility').value = S.market.volatility;
  $('railSim').classList.toggle('on', sim);
  $('modeTag').textContent = sim ? `Symulacja · zmienność ${S.market.volatility}×` : 'Na żywo · LSE';
  $('modeTag').classList.toggle('sim', sim);
}

function selectPair(s) {
  S.symbol = s;
  store.set('symbol', s);
  bookSizes.clear();
  prevMid = null;
  $('pairCoins').innerHTML = coins(s);
  $('pairName').textContent = label(s);
  $('pairLong').textContent = names(s);
  $('price').className = 'price';
  for (const id of ['pairList', 'searchList']) $(id).hidden = true;
  $('search').value = '';
  prefillPrice();
  renderTicker();
  renderForm();
  renderOrders();
  renderBook();
  loadChart();
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
  Object.assign(S, { pairs: st.pairs, quotes: st.quotes, stats: st.stats, account: st.account, market: st.market });
  if (!S.pairs.includes(S.symbol)) S.symbol = S.pairs[0];
  if (!st.ranges.includes(S.range)) S.range = '1D';
  $('ranges').innerHTML = st.ranges.map((r) => `<button type="button" data-range="${r}" class="${r === S.range ? 'on' : ''}">${r}</button>`).join('');
  if (Object.keys(S.stats).length < S.pairs.length) setTimeout(refresh, 5000); // server still warming up
  renderMode();
  renderWallet();
  renderOrders();
  renderTicker();
  renderForm();
  if (wasMode !== S.market.mode) loadChart();
}

// Events
document.addEventListener('click', (e) => {
  for (const [id, trigger] of [['pairList', '#pairBtn'], ['searchList', '.search'], ['notes', '#bell']]) {
    if (!$(id).hidden && !e.target.closest(`#${id}`) && !e.target.closest(trigger)) $(id).hidden = true;
  }
  const row = e.target.closest('[data-sym]');
  if (row) selectPair(row.dataset.sym);
});
$('pairBtn').onclick = () => {
  $('pairList').innerHTML = pairRows('');
  $('pairList').hidden = !$('pairList').hidden;
};
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
  S.unread = 0;
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
$('dispCoin').innerHTML = CCY[S.display][1];
$('dispCoin').style.background = CCY[S.display][2];
$('display').onchange = () => {
  S.display = $('display').value;
  store.set('display', S.display);
  $('dispCoin').innerHTML = CCY[S.display][1];
  $('dispCoin').style.background = CCY[S.display][2];
  renderWallet();
};

$('ranges').onclick = (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  S.range = b.dataset.range;
  store.set('range', S.range);
  $('ranges').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  loadChart();
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
  S.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
  $('chart').hidden = S.view !== 'chart';
  $('book').hidden = S.view !== 'book';
  $('styleSeg').hidden = S.view !== 'chart';
  renderBook();
}));
document.querySelectorAll('[data-style]').forEach((b) => (b.onclick = () => {
  S.style = b.dataset.style;
  document.querySelectorAll('[data-style]').forEach((x) => x.classList.toggle('on', x === b));
  candleSeries.applyOptions({ visible: S.style === 'candle' });
  lineSeries.applyOptions({ visible: S.style === 'line' });
}));
document.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => {
  S.side = b.dataset.side;
  document.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('on', x === b));
  prefillPrice();
  renderForm();
}));
document.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => {
  S.type = b.dataset.type;
  document.querySelectorAll('[data-type]').forEach((x) => x.classList.toggle('on', x === b));
  prefillPrice();
  renderForm();
}));
$('amountIn').oninput = renderForm;
$('priceIn').oninput = renderForm;
document.querySelectorAll('[data-pct]').forEach((b) => (b.onclick = () => {
  const { base, quote, price } = formState();
  const pay = S.side === 'buy' ? quote : base;
  const have = S.account?.available[pay] ?? 0;
  const amt = S.side === 'buy' ? have / (price * (1 + FEE)) : have;
  if (!(amt > 0)) return;
  $('amountIn').value = fmt(Math.floor(amt * (Number(b.dataset.pct) / 100) * 100) / 100).replace(/\s/g, '');
  renderForm();
}));

$('trade').onsubmit = async (e) => {
  e.preventDefault();
  const { s, amount } = formState();
  $('formErr').textContent = '';
  if (!(amount > 0)) return ($('formErr').textContent = 'Podaj ilość większą od zera');
  $('submit').disabled = true;
  try {
    const o = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ symbol: s, side: S.side, type: S.type, amount, price: S.type === 'market' ? undefined : parse($('priceIn').value) }),
    });
    toast(o.status === 'filled' ? `Zrealizowano: ${describe(o)}` : `Przyjęto zlecenie ${KIND[o.type]}: ${describe(o)}`);
    $('amountIn').value = '';
  } catch (err) {
    $('formErr').textContent = err.message;
  } finally {
    $('submit').disabled = false;
    renderForm();
  }
};

$('orderFilter').onchange = renderOrders;
$('onlyPair').onchange = renderOrders;
$('orderList').onclick = async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  try {
    await api(`/api/orders/${b.dataset.cancel}`, { method: 'DELETE' });
    toast('Zlecenie anulowane');
  } catch (err) {
    toast(err.message, 'err');
  }
};
$('reset').onclick = async () => {
  if (!confirm('Zresetować konto do stanu początkowego? Wszystkie zlecenia zostaną usunięte.')) return;
  await api('/api/reset', { method: 'POST' }).catch((err) => toast(err.message, 'err'));
};

function connect() {
  const es = new EventSource('/api/stream');
  let opened = false;
  es.onopen = () => { if (opened) refresh().catch(() => {}); opened = true; };
  es.addEventListener('quotes', (e) => {
    const batch = JSON.parse(e.data);
    Object.assign(S.quotes, batch);
    const q = batch[S.symbol];
    if (q) {
      renderTicker();
      tickChart(q);
      renderBook();
      if (S.type === 'market') renderForm();
    }
    renderWallet();
  });
  es.addEventListener('account', (e) => {
    S.account = JSON.parse(e.data);
    renderWallet();
    renderOrders();
    renderForm();
  });
  es.addEventListener('order', (e) => {
    const o = JSON.parse(e.data);
    if (o.status === 'filled') toast(`Zrealizowano zlecenie ${KIND[o.type]}: ${describe(o)}`);
    else toast(`Odrzucono zlecenie ${KIND[o.type]}: ${o.reason}`, 'err');
  });
  es.addEventListener('mode', (e) => {
    const was = S.market.mode;
    S.market = JSON.parse(e.data);
    renderMode();
    if (was !== S.market.mode) loadChart(); // drop simulated candles, or start the sim from fresh history
  });
  es.addEventListener('news', (e) => {
    const n = JSON.parse(e.data);
    const pct = n.change * 100;
    toast(`Symulacja: ${CCY[n.currency][0]} ${pct > 0 ? 'zyskuje' : 'traci'} ${fmt(Math.abs(pct))}% wobec USD`, 'news');
  });
}

setInterval(updateMeters, 1000);
refresh()
  .then(() => selectPair(S.symbol))
  .catch((e) => chartMsg(`Serwer nie odpowiada: ${e.message}`))
  .finally(connect);
