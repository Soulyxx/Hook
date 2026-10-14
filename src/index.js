'use strict';
const express = require('express');
const fs = require('fs');

function tryReq(...p) {
  const tried = [];
  for (const x of p) { tried.push(x); try { return require(x); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; } }
  console.error('[boot] no pude cargar: ' + tried.join(', '));
  console.error('[boot] en ' + __dirname + ': ' + fs.readdirSync(__dirname).join(', '));
  throw new Error('modulo faltante');
}

const { Store }    = tryReq('./store', './src/store');
const apiRouter    = tryReq('./api', './src/api');
const { startBot } = tryReq('./bot', './src/bot');

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || './data';
const AUTH_SECRET = process.env.AUTH_SECRET || '';

const store = new Store(DATA_DIR);
let bot = null;
let bootError = null;

const hits = new Map();
function rl(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  if (rec.n > 400) return res.status(429).json({ ok: false, error: 'rate' });
  next();
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(rl);

app.get('/', (_q, r) => r.json({ ok: true, service: 'hook-slx-auth', version: '3.0.0' }));

app.get('/health', (_q, r) => {
  const b = bot ? bot.status() : null;
  r.json({
    ok: true, instanceId: store.instance, db: store.file, dbWritable: store.writable,
    users: store.list().length, pending: store.count('pending'),
    bot: b ? (b.online ? 'online' : 'offline') : 'disabled',
    botTag: b ? b.tag : null, intents: b ? b.intents : null, guilds: b ? b.guilds : 0,
    panel: b ? b.panel : null, secretRequired: !!AUTH_SECRET,
    lastError: (b && b.lastError) || bootError || null,
    autoApprove: !!process.env.AUTO_APPROVE
  });
});

app.use('/api', apiRouter(store, AUTH_SECRET, (kind, u) => {
  if (kind === 'new' && bot) bot.notifyNew(u).catch((e) => console.error('[bot] notify:', e.message));
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('──────────────────────────────────────────');
  console.log('[auth] escuchando  :' + PORT);
  console.log('[auth] instancia    : ' + store.instance);
  console.log('[auth] base         : ' + store.file + (store.writable ? '' : '  <<< SOLO LECTURA'));
  console.log('[auth] AUTH_SECRET  : ' + (AUTH_SECRET ? 'ON' : 'OFF'));
  console.log('──────────────────────────────────────────');
});

startBot(store)
  .then((b) => { bot = b; if (!b) console.warn('[auth] bot DESACTIVADO'); })
  .catch((e) => { bootError = e.message; console.error('[bot] arranque:', e.message); });

function shutdown() { try { store.flush(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandled]', (e && e.message) || e));