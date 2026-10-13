const express = require('express');
const store = require('./store');

let onNewRequest = () => {};

function startApi(bot) {
  onNewRequest = bot.notifyPending;
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => res.json({ ok: true, service: 'souly-auth' }));

  app.post('/api/hello', (req, res) => {
    const { hwid, pc, user, version } = req.body || {};
    if (!hwid) return res.status(400).json({ error: 'missing hwid' });

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const existing = store.get(hwid);

    if (existing && existing.status === 'blacklisted') return res.json({ status: 'blacklisted' });
    if (existing && existing.status === 'denied') return res.json({ status: 'denied' });

    if (existing && existing.status === 'approved') {
      const u = store.upsert(hwid, { pc, user, version, ip, sessions: (existing.sessions || 0) + 1 });
      return res.json({ status: 'approved', token: u.token, name: u.pc });
    }

    const isNew = !existing;
    const u = store.upsert(hwid, { pc, user, version, ip });
    if (isNew) {
      store.log('new request: ' + pc);
      onNewRequest(u).catch(() => {});
    }
    res.json({ status: 'pending' });
  });

  app.get('/api/verify', (req, res) => {
    const { hwid, token } = req.query;
    const u = store.get(hwid);
    if (!u) return res.json({ ok: false, reason: 'unknown' });
    if (u.status === 'blacklisted') return res.json({ ok: false, reason: 'blacklisted' });
    if (u.status !== 'approved') return res.json({ ok: false, reason: u.status });
    if (u.token !== token) return res.json({ ok: false, reason: 'token' });
    store.upsert(hwid, {});
    res.json({ ok: true, name: u.pc });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('[api] listening on ' + port));
}

module.exports = { startApi };