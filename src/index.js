'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');

function tryReq(...p) {
  const tried = [];
  for (const x of p) {
    tried.push(x);
    try { return require(x); }
    catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes(x)) throw e; }
  }
  console.error('[boot] no pude cargar ninguno de: ' + tried.join(', '));
  console.error('[boot] en ' + __dirname + ': ' + fs.readdirSync(__dirname).join(', '));
  throw new Error('modulo faltante: ' + p.join(' | '));
}

const { Store }    = tryReq('./store', './src/store');
const apiRouter    = tryReq('./api', './src/api');
const { startBot } = tryReq('./bot', './src/bot');

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || './data';
const AUTH_SECRET = process.env.AUTH_SECRET || '';

console.log('[boot] __dirname = ' + __dirname);

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

app.get('/', (_q, r) => r.json({ ok: true, service: 'hook-slx-auth', version: '1.3.0' }));

app.get('/health', (_q, r) => {
  const b = bot ? bot.status() : null;
  r.json({
    ok: true,
    dir: __dirname,
    users: store.list().length,
    pending: store.count('pending'),
    bot: b ? (b.online ? 'online' : 'offline') : 'disabled',
    botTag: b ? b.tag : null,
    botId: b ? b.id : null,
    intents: b ? b.intents : null,
    guilds: b ? b.guilds : 0,
    panel: b ? b.panel : null,
    lastError: (b && b.lastError) || bootError || null,
    autoApprove: !!process.env.AUTO_APPROVE
  });
});

app.use('/api', apiRouter(store, AUTH_SECRET, (kind, u) => {
  if (kind === 'new' && bot) bot.notifyNew(u).catch((e) => console.error('[bot] notify:', e.message));
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log('──────────────────────────────────────────');
  console.log('[auth] escuchando en :' + PORT);
  console.log('[auth] AUTH_SECRET   : ' + (AUTH_SECRET ? 'ON' : 'OFF (sin proteccion)'));
  console.log('[auth] DATA_DIR      : ' + DATA_DIR);
  console.log('[auth] AUTO_APPROVE  : ' + (process.env.AUTO_APPROVE ? 'ON' : 'off'));
  console.log('[auth] DISCORD_TOKEN : ' + (process.env.DISCORD_TOKEN ? 'presente' : 'FALTA'));
  console.log('[auth] OWNER_ID      : ' + (process.env.OWNER_ID || 'FALTA'));
  console.log('[auth] PANEL_CHANNEL : ' + (process.env.PANEL_CHANNEL_ID || 'auto'));
  console.log('──────────────────────────────────────────');
});

startBot(store)
  .then((b) => { bot = b; if (!b) console.warn('[auth] bot DESACTIVADO (sin token)'); })
  .catch((e) => { bootError = e.message; console.error('[bot] arranque fallo:', e.message); });

function shutdown() { try { store.flush(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('[unhandled]', (e && e.message) || e));