import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarket, PAIRS, RANGES } from './market.js';
import { createAccount, placeOrder, cancelOrder, matchOrders, available, START } from './exchange.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(root, '../public');
const DATA = path.join(root, '../data/account.json');
const VENDOR = path.join(root, '../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.mjs');
const PORT = Number(process.env.PORT) || 3000;

try { process.loadEnvFile(path.join(root, '../.env')); } catch {}
const KEY = process.env.LSE_API_KEY;
if (!KEY) {
  console.error('Brak LSE_API_KEY. Skopiuj .env.example do .env i wpisz klucz.');
  process.exit(1);
}

let account;
try { account = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { account = createAccount(); }
function save() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(account));
  fs.renameSync(DATA + '.tmp', DATA);
}
const accountView = () => ({ start: START, balances: account.balances, available: available(account), orders: account.orders.slice(-200) });

const market = createMarket(KEY);
const clients = new Set();
const broadcast = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };

let pending = {};
market.on('quote', (s, q) => {
  pending[s] = q;
  const closed = matchOrders(account, s, q);
  if (closed.length) {
    save();
    broadcast('account', accountView());
    for (const o of closed) broadcast('order', o);
  }
});
market.on('mode', (m) => broadcast('mode', m));
market.on('event', (e) => broadcast('news', e));
setInterval(() => {
  if (!Object.keys(pending).length) return;
  broadcast('quotes', pending);
  pending = {};
}, 250);

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };
const json = (res, code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Nieprawidłowy JSON')); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/state') {
    return json(res, 200, { pairs: PAIRS, ranges: Object.keys(RANGES), quotes: market.quotes(), stats: market.stats, market: market.status(), account: accountView() });
  }
  if (route === 'GET /api/candles') {
    const symbol = url.searchParams.get('symbol');
    const range = url.searchParams.get('range');
    if (!PAIRS.includes(symbol) || !RANGES[range]) return json(res, 400, { error: 'Nieznana para lub zakres' });
    return json(res, 200, { step: RANGES[range][1], candles: await market.candles(symbol, range) });
  }
  if (route === 'GET /api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (route === 'POST /api/orders') {
    const input = await body(req);
    const order = placeOrder(account, input, PAIRS, market.quote(input?.symbol));
    save();
    broadcast('account', accountView());
    return json(res, 200, order);
  }
  const cancel = route.match(/^DELETE \/api\/orders\/(\d+)$/);
  if (cancel) {
    const order = cancelOrder(account, Number(cancel[1]));
    save();
    broadcast('account', accountView());
    return json(res, 200, order);
  }
  if (route === 'POST /api/reset') {
    account = createAccount();
    save();
    broadcast('account', accountView());
    return json(res, 200, { ok: true });
  }
  if (route === 'POST /api/market') {
    const { mode, volatility } = await body(req);
    market.setMode(mode, Number(volatility));
    return json(res, 200, market.status());
  }
  json(res, 404, { error: 'Nie znaleziono' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => json(res, e.message.startsWith('LSE') ? 502 : 400, { error: e.message }));
  }
  let file;
  try {
    file = url.pathname === '/vendor/lightweight-charts.mjs'
      ? VENDOR
      : path.join(PUBLIC, path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  } catch { file = ''; }
  if (file !== VENDOR && !file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Brak dostępu' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Nie znaleziono' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`terefere działa na http://localhost:${PORT}`));

market.start();
