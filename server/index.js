import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMarket, rateIn, PAIRS, RANGES } from './market.js';
import { createAccount, placeOrder, cancelOrder, closePosition, protectPosition, matchOrders, available, START, ACCOUNT, FEE, MARGIN_FEE, MAX_LEVERAGE, CLOSE_OUT } from './exchange.js';

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
account.positions ??= []; // accounts saved before leverage existed
function save() {
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(account));
  fs.renameSync(DATA + '.tmp', DATA);
}
const accountView = () => ({
  start: START,
  balances: account.balances,
  available: available(account),
  orders: account.orders.slice(-200),
  positions: account.positions.filter((p, i, a) => p.status === 'open' || i >= a.length - 100),
});
const RULES = { account: ACCOUNT, fee: FEE, marginFee: MARGIN_FEE, maxLeverage: MAX_LEVERAGE, closeOut: CLOSE_OUT };

fs.mkdirSync(path.dirname(DATA), { recursive: true });
const market = createMarket(KEY, { cacheFile: path.join(root, '../data/candles.json') });
const rate = (c) => rateIn(market.quotes(), c, ACCOUNT);
const clients = new Set();
const broadcast = (type, data) => { for (const res of clients) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };

let pending = {};
market.on('quote', (s, q) => {
  pending[s] = q;
  const { orders, positions } = matchOrders(account, s, q, rate);
  if (!orders.length && !positions.length) return;
  save();
  broadcast('account', accountView());
  for (const o of orders) broadcast('order', o);
  for (const p of positions) broadcast('position', p);
});
market.on('mode', (m) => broadcast('mode', m));
market.on('event', (e) => broadcast('news', e));
setInterval(() => {
  if (!Object.keys(pending).length) return;
  broadcast('quotes', pending);
  pending = {};
}, 250);

// Responses are gzipped when the browser accepts it; static files are revalidated by ETag.
function send(req, res, code, type, body, extra = {}) {
  const gzip = body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  res.writeHead(code, { 'content-type': type, vary: 'accept-encoding', ...(gzip && { 'content-encoding': 'gzip' }), ...extra });
  res.end(gzip ? zlib.gzipSync(body) : body);
}
const json = (req, res, code, data) => send(req, res, code, 'application/json', Buffer.from(JSON.stringify(data)));

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };
const files = new Map();
function serveFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return json(req, res, 404, { error: 'Nie znaleziono' }); }
  let f = files.get(file);
  if (!f || f.mtime !== stat.mtimeMs) {
    const raw = fs.readFileSync(file);
    f = { mtime: stat.mtimeMs, raw, etag: `"${createHash('sha1').update(raw).digest('base64url')}"` };
    files.set(file, f);
  }
  if (req.headers['if-none-match'] === f.etag) return res.writeHead(304, { etag: f.etag }).end();
  send(req, res, 200, TYPES[path.extname(file)] ?? 'application/octet-stream', f.raw, { etag: f.etag, 'cache-control': 'no-cache' });
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Nieprawidłowy JSON')); } });
    req.on('error', reject);
  });
}

function changed(req, res, data) {
  save();
  broadcast('account', accountView());
  json(req, res, 200, data);
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/state') {
    return json(req, res, 200, { pairs: PAIRS, ranges: Object.keys(RANGES), rules: RULES, quotes: market.quotes(), stats: market.stats, market: market.status(), account: accountView() });
  }
  if (route === 'GET /api/candles') {
    const symbol = url.searchParams.get('symbol');
    const range = url.searchParams.get('range');
    if (!PAIRS.includes(symbol) || !RANGES[range]) return json(req, res, 400, { error: 'Nieznana para lub zakres' });
    return json(req, res, 200, await market.candles(symbol, range));
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
    return changed(req, res, placeOrder(account, input, PAIRS, market.quote(input?.symbol), rate));
  }
  const cancel = route.match(/^DELETE \/api\/orders\/(\d+)$/);
  if (cancel) return changed(req, res, cancelOrder(account, Number(cancel[1])));
  const close = route.match(/^POST \/api\/positions\/(\d+)\/close$/);
  if (close) {
    const p = account.positions.find((x) => x.id === Number(close[1]));
    return changed(req, res, closePosition(account, Number(close[1]), p && market.quote(p.symbol), rate));
  }
  const protect = route.match(/^POST \/api\/positions\/(\d+)\/protect$/);
  if (protect) {
    const p = account.positions.find((x) => x.id === Number(protect[1]));
    return changed(req, res, protectPosition(account, Number(protect[1]), await body(req), p && market.quote(p.symbol)));
  }
  if (route === 'POST /api/reset') {
    account = createAccount();
    return changed(req, res, { ok: true });
  }
  if (route === 'POST /api/market') {
    const { mode, volatility } = await body(req);
    market.setMode(mode, Number(volatility));
    return json(req, res, 200, market.status());
  }
  json(req, res, 404, { error: 'Nie znaleziono' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, url).catch((e) => json(req, res, e.message.startsWith('LSE') ? 502 : 400, { error: e.message }));
  }
  let file;
  try {
    file = url.pathname === '/vendor/lightweight-charts.mjs'
      ? VENDOR
      : path.join(PUBLIC, path.normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
  } catch { file = ''; }
  if (file !== VENDOR && !file.startsWith(PUBLIC + path.sep)) return json(req, res, 403, { error: 'Brak dostępu' });
  serveFile(req, res, file);
}).listen(PORT, '127.0.0.1', () => console.log(`terefere działa na http://localhost:${PORT}`));

market.start();
