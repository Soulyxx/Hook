'use strict';
const express = require('express');
const { Store } = require('./src/store');
const apiRouter = require('./src/api');
const { startBot } = require('./src/bot');

const PORT        = process.env.PORT || 3000;
const DATA_DIR    = process.env.DATA_DIR || './data';
const AUTH_SECRET = process.env.AUTH_SECRET || '';

const store = new Store(DATA_DIR);

// rate limit tonto en memoria
const hits = new Map();
function rl(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60_000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(ip, rec);
  if (rec.n > 240) return res.status(429).json({ ok: false, error: 'rate' });
  next();
}

(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use(rl);

  const bot = await startBot(store).catch((e) => { console.error('[bot]', e.message); return null; });

  app.use('/api', apiRouter(store, AUTH_SECRET, (kind, u) => {
    if (bot && bot.notifyNew && kind === 'new') bot.notifyNew(u);
  }));

  app.get('/', (_req, res) => res.json({ ok: true, service: 'hook-slx-auth' }));

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[auth] escuchando en :${PORT}`);
    console.log(`[auth] secret: ${AUTH_SECRET ? 'ON' : 'OFF (sin proteccion)'}`);
    console.log(`[auth] data dir: ${DATA_DIR}`);
  });
})();