// Market data: live ticks from LSE WebSocket, history from LSE export, and a simulated market.
import { EventEmitter } from 'node:events';

const API = 'https://download.londonstrategicedge.com/v3';
const WS = 'wss://data-ws.londonstrategicedge.com';

// The free LSE key streams at most 16 symbols on one connection.
export const PAIRS = [
  'EUR_PLN', 'USD_PLN', 'GBP_PLN', 'EUR_USD', 'GBP_USD', 'USD_JPY', 'USD_CHF', 'AUD_USD',
  'USD_CAD', 'NZD_USD', 'EUR_GBP', 'EUR_JPY', 'EUR_CHF', 'GBP_JPY', 'AUD_JPY', 'EUR_AUD',
];
export const RANGES = { '1D': ['5m', 300, 1], '7D': ['1h', 3600, 7], '1M': ['4h', 14400, 31], '3M': ['1d', 86400, 92], '1Y': ['1d', 86400, 365] };
export const VOLATILITY = [1, 3, 10];

const mid = (q) => (q.bid + q.ask) / 2;
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const day = (d) => new Date(d).toISOString().slice(0, 10);

// values: currency -> its price in USD. Every pair is derived from them, so cross rates always agree.
export function crossQuote(symbol, values, spread, ts) {
  const [b, q] = symbol.split('_');
  const m = values[b] / values[q];
  return { bid: m * (1 - spread / 2), ask: m * (1 + spread / 2), ts };
}

export function createMarket(key) {
  const ev = new EventEmitter();
  const live = {};
  const stats = {};
  const cache = new Map();
  let queue = Promise.resolve();
  let mode = 'live';
  let volatility = 1;
  let simTimer = null;
  let values = {};
  const spread = (s) => (live[s] ? Math.max((live[s].ask - live[s].bid) / mid(live[s]), 2e-5) : 1e-4);

  async function exportCsv(symbol, tf, days) {
    const url = `${API}/export?market=forex&symbol=${symbol}&timeframe=${tf}&from=${day(Date.now() - days * 864e5)}&to=${day(Date.now())}&format=csv`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'X-API-Key': key } });
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

  // LSE allows one download per key at a time, so exports run one after another.
  function candles(symbol, range) {
    const [tf, , days] = RANGES[range];
    const k = `${symbol}:${range}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < (range === '1D' ? 60e3 : 300e3)) return hit.data;
    const data = (queue = queue.catch(() => {}).then(() => exportCsv(symbol, tf, days)));
    cache.set(k, { at: Date.now(), data });
    data.catch(() => cache.delete(k));
    return data;
  }

  // 24h stats and hourly volatility from the last 24 / 120 trading hours.
  async function loadStats(symbol) {
    const c = await candles(symbol, '7D');
    if (!c.length) return;
    const d = c.slice(-24);
    const r = c.slice(-121).map((x, i, a) => (i ? Math.log(x.close / a[i - 1].close) : 0)).slice(1);
    const sd = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / Math.max(r.length, 1)) || 1e-3;
    stats[symbol] = { open24: d[0].open, high24: Math.max(...d.map((x) => x.high)), low24: Math.min(...d.map((x) => x.low)), trades24: d.reduce((s, x) => s + x.trades, 0), vol: sd };
    const last = c.at(-1);
    live[symbol] ??= { bid: last.close, ask: last.close, ts: last.time * 1000 };
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
        live[s] = { bid: m.bid ?? m.price, ask: m.ask ?? m.price, ts: Date.parse(m.ts) || Date.now() };
        if (mode === 'live') ev.emit('quote', s, live[s]);
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
  // real hourly data, a shared USD factor (currencies move together), and rare news jumps.
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
    volatility = vol;
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
    mode = next;
    ev.emit('mode', status());
    if (mode === 'live') for (const s of PAIRS) if (live[s]) ev.emit('quote', s, live[s]);
  }

  const status = () => ({ mode, volatility });
  let current = {};
  ev.on('quote', (s, q) => (current[s] = q));
  const quote = (s) => current[s];

  async function start() {
    for (const s of PAIRS) await loadStats(s).catch((e) => console.error(s, e.message));
    current = { ...live };
    connect();
    setInterval(() => PAIRS.forEach((s) => loadStats(s).catch(() => {})), 30 * 60e3);
  }

  return Object.assign(ev, { start, candles, quote, quotes: () => current, stats, setMode, status });
}
