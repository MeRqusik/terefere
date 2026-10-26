// Market data: live ticks from LSE WebSocket, history from LSE export, and a simulated market.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { addTick } from '../public/candles.js';

const API = 'https://download.londonstrategicedge.com/v3';
const WS = 'wss://data-ws.londonstrategicedge.com';

// The free LSE key streams at most 16 symbols on one connection.
export const PAIRS = [
  'EUR_PLN', 'USD_PLN', 'GBP_PLN', 'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD',
  'USD_CAD', 'NZD_USD', 'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'GBP_JPY', 'AUD_JPY', 'EUR_AUD',
];
// Stored series: timeframe -> [seconds per bar, days fetched]. Ranges show a series, 3M as the tail of the yearly one.
export const SERIES = { '5m': [300, 1], '1h': [3600, 7], '4h': [14400, 31], '1d': [86400, 365] };
export const RANGES = { '1D': ['5m'], '7D': ['1h'], '1M': ['4h'], '3M': ['1d', 92], '1Y': ['1d'] };
export const VOLATILITY = [1, 3, 10];
const REFRESH = 30 * 60e3;

const mid = (q) => (q.bid + q.ask) / 2;
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const day = (d) => new Date(d).toISOString().slice(0, 10);

// values: currency -> its price in USD. Every pair is derived from them, so cross rates always agree.
export function crossQuote(symbol, values, spread, ts) {
  const [b, q] = symbol.split('_');
  const m = values[b] / values[q];
  return { bid: m * (1 - spread / 2), ask: m * (1 + spread / 2), ts };
}

// How many `target` one unit of `ccy` is worth, through the USD pairs.
export function rateIn(quotes, ccy, target) {
  const usd = (c) => {
    if (c === 'USD') return 1;
    const a = quotes[`${c}_USD`];
    const b = quotes[`USD_${c}`];
    return a ? mid(a) : b ? 1 / mid(b) : NaN;
  };
  return usd(ccy) / usd(target);
}

export function createMarket(key, { cacheFile } = {}) {
  const ev = new EventEmitter();
  const headers = { 'X-API-Key': key };
  const live = {};
  const current = {};
  const stats = {};
  const cache = new Map();
  // Candles survive restarts on disk: a restarted server shows charts at once and refreshes them in the background.
  try {
    for (const [k, { at, bars }] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) cache.set(k, { at, bars, data: Promise.resolve(bars) });
  } catch {}
  let saveTimer = null;
  const persist = () => {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const out = Object.fromEntries([...cache].filter(([, c]) => c.bars).map(([k, c]) => [k, { at: c.at, bars: c.bars }]));
      fs.promises.writeFile(cacheFile + '.tmp', JSON.stringify(out)).then(() => fs.promises.rename(cacheFile + '.tmp', cacheFile)).catch(() => {});
    }, 10e3);
  };
  let mode = 'live';
  let volatility = 1;
  let simTimer = null;
  let values = {};
  const spread = (s) => (live[s] ? Math.max((live[s].ask - live[s].bid) / mid(live[s]), 2e-5) : 1e-4);
  ev.on('quote', (s, q) => (current[s] = q));

  // LSE allows one export per key at a time: run them in turn, what the user is waiting for first.
  // Background jobs run at most once a second, which keeps them under the 60 calls a minute limit.
  const jobs = [[], []];
  let busy = false;
  let lastBackground = 0;
  const enqueue = (fn, urgent) => new Promise((resolve, reject) => { jobs[urgent ? 0 : 1].push({ fn, resolve, reject }); pump(); });
  async function pump() {
    if (busy) return;
    let job = jobs[0].shift();
    if (!job && jobs[1].length) {
      const wait = lastBackground + 1000 - Date.now();
      if (wait > 0) return void setTimeout(pump, wait);
      job = jobs[1].shift();
      lastBackground = Date.now();
    }
    if (!job) return;
    busy = true;
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
    busy = false;
    pump();
  }

  async function exportCsv(symbol, tf) {
    const days = SERIES[tf][1];
    const url = `${API}/export?market=forex&symbol=${symbol}&timeframe=${tf}&from=${day(Date.now() - days * 864e5)}&to=${day(Date.now())}&format=csv`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers });
      if (res.ok) {
        return (await res.text()).trim().split('\n').slice(1).map((line) => {
          const [t, open, high, low, close, , trades] = line.split(',');
          return { time: Date.parse(t.replaceAll('"', '').replace(' ', 'T') + 'Z') / 1000, open: +open, high: +high, low: +low, close: +close, trades: +trades };
        });
      }
      const body = await res.json().catch(() => ({}));
      if (res.status !== 429 || attempt > 1) throw new Error(`LSE ${res.status} ${body.code ?? ''} ${body.message ?? ''}`.trim());
      await new Promise((r) => setTimeout(r, Math.min(body.retry_after ?? 3, 60) * 1000));
    }
  }

  // Cached series are kept current by live ticks, so they are only re-downloaded every 30 minutes,
  // and then in the background while the cached copy is served.
  function series(symbol, tf, urgent = true) {
    const k = `${symbol}:${tf}`;
    const c = cache.get(k);
    if (c && (c.loading || Date.now() - c.at < REFRESH)) return c.data;
    const load = enqueue(() => exportCsv(symbol, tf), urgent && !c).then((bars) => {
      cache.set(k, { at: Date.now(), bars, data: Promise.resolve(bars) });
      persist();
      return bars;
    });
    if (c) {
      c.loading = true;
      load.catch(() => (c.loading = false));
      return c.data;
    }
    cache.set(k, { at: 0, loading: true, data: load });
    load.catch(() => cache.delete(k));
    return load;
  }

  async function candles(symbol, range) {
    const [tf, days] = RANGES[range];
    const bars = await series(symbol, tf);
    for (const other of Object.keys(SERIES)) series(symbol, other, false).catch(() => {}); // next range click is instant
    const from = days ? Date.now() / 1000 - days * 86400 : -Infinity;
    return { step: SERIES[tf][0], candles: days ? bars.filter((b) => b.time >= from) : bars };
  }

  // Today's bar and volatility from one small call per pair; previews may run in parallel, exports may not.
  async function loadStats(symbol) {
    const res = await fetch(`${API}/preview?market=forex&symbol=${symbol}&timeframe=1d`, { headers });
    if (!res.ok) throw new Error(`LSE ${res.status}`);
    const rows = (await res.json()).rows ?? [];
    if (!rows.length) return;
    const d = rows.at(-1);
    const r = rows.slice(1).map((x, i) => Math.log(x.close / rows[i].close));
    const daily = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / Math.max(r.length, 1));
    stats[symbol] = { open: d.open, high: d.high, low: d.low, trades: d.trades, vol: daily / Math.sqrt(24) || 1e-3 };
    live[symbol] ??= { bid: d.close, ask: d.close, ts: Date.parse(d.time.replace(' ', 'T') + 'Z') };
    current[symbol] ??= live[symbol];
  }

  function connect() {
    const ws = new WebSocket(WS);
    let ping;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'welcome') ws.send(JSON.stringify({ action: 'auth', api_key: key }));
      else if (m.type === 'authenticated') {
        for (const p of PAIRS) ws.send(JSON.stringify({ action: 'subscribe', symbol: p.replace('_', '/') }));
        ping = setInterval(() => ws.send('{"action":"ping"}'), 60e3);
      } else if (m.type === 'tick') {
        const s = m.symbol.replace('/', '_');
        const q = (live[s] = { bid: m.bid ?? m.price, ask: m.ask ?? m.price, ts: Date.parse(m.ts) || Date.now() });
        for (const tf of Object.keys(SERIES)) {
          const bars = cache.get(`${s}:${tf}`)?.bars;
          if (bars) addTick(bars, SERIES[tf][0], Math.floor(q.ts / 1000), mid(q));
        }
        if (mode === 'live') ev.emit('quote', s, q);
      } else if (m.type === 'error') console.error('LSE WebSocket:', m.code, m.message);
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      console.error(`LSE WebSocket zamknięty (${e.code}), ponawiam za 5 s`);
      setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  }

  // Simulation: each currency's USD value follows a random walk with the volatility seen in
  // real data, a shared USD factor (currencies move together), and rare news jumps.
  function simStep(dt) {
    const common = gauss();
    for (const c of Object.keys(values)) {
      if (c === 'USD') continue;
      const p = PAIRS.find((x) => x === `${c}_USD` || x === `USD_${c}`);
      const sigma = (stats[p]?.vol ?? 1e-3) * volatility;
      let r = sigma * Math.sqrt(dt / 3600) * (0.5 * common + 0.87 * gauss());
      if (Math.random() < (dt / 900) * volatility / 8) {
        r += (Math.random() < 0.5 ? -1 : 1) * sigma * (2 + 4 * Math.random());
        ev.emit('event', { currency: c, change: Math.expm1(r) });
      }
      values[c] *= Math.exp(r);
    }
    const ts = Date.now();
    for (const s of PAIRS) ev.emit('quote', s, crossQuote(s, values, spread(s) * (1 + (volatility - 1) / 3), ts));
  }

  function setMode(next, vol = volatility) {
    if (!['live', 'sim'].includes(next) || !VOLATILITY.includes(vol)) throw new Error('Nieprawidłowy tryb');
    if (next === 'sim' && mode !== 'sim') {
      if (PAIRS.some((s) => !live[s])) throw new Error('Brak notowań, nie da się wystartować symulacji');
      values = { USD: 1 };
      for (const s of PAIRS) {
        const [b, q] = s.split('_');
        if (q === 'USD') values[b] = mid(live[s]);
        if (b === 'USD') values[q] = 1 / mid(live[s]);
      }
      simTimer = setInterval(() => simStep(0.5), 500);
    }
    if (next === 'live' && mode === 'sim') clearInterval(simTimer);
    volatility = vol;
    mode = next;
    ev.emit('mode', status());
    if (mode === 'live') for (const s of PAIRS) if (live[s]) ev.emit('quote', s, live[s]);
  }

  const status = () => ({ mode, volatility });

  function start() {
    connect();
    // Then every chart not on disk yet, shortest ranges first; stale ones refresh when someone opens them.
    Promise.all(PAIRS.map((s) => loadStats(s).catch((e) => console.error(s, e.message)))).then(() => {
      for (const tf of Object.keys(SERIES)) for (const s of PAIRS) if (!cache.has(`${s}:${tf}`)) series(s, tf, false).catch(() => {});
    });
    setInterval(() => PAIRS.forEach((s) => loadStats(s).catch(() => {})), 10 * 60e3);
  }

  return Object.assign(ev, { start, candles, quote: (s) => current[s], quotes: () => current, stats, setMode, status });
}
