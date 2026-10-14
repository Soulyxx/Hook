'use strict';
const express = require('express');
const crypto = require('crypto');

const cleanHwid = (v) => String(v || '').trim().toUpperCase().slice(0, 64);

function gate(secret) {
  const sb = Buffer.from(String(secret));
  return (req, res, next) => {
    if (!secret) return next();
    const got = Buffer.from(String(req.get('x-auth-secret') || req.query.k || ''));
    if (got.length === sb.length && crypto.timingSafeEqual(got, sb)) return next();
    res.status(401).json({ ok: false, error: 'bad_secret' });
  };
}

module.exports = function apiRouter(store, secret, notify) {
  const r = express.Router();
  const AUTO = () => !!process.env.AUTO_APPROVE;

  /* ---- SIN gate: sirve para distinguir "no llego" de "secret malo" ---- */
  r.get('/ping', (_q, res) => res.json({ ok: true, service: 'hook-slx-auth', time: Date.now(), secretRequired: !!secret }));

  r.use(gate(secret));

  const pushNotify = (u) => {
    if (!notify) return;
    store.set(u.hwid, { notifiedAt: Date.now() });
    try { notify('new', store.get(u.hwid)); } catch (e) { console.error('[api] notify:', e.message); }
  };

  r.post('/hello', (req, res) => {
    const hwid = cleanHwid(req.body && req.body.hwid);
    if (hwid.length < 8) return res.status(400).json({ ok: false, error: 'bad_hwid' });
    const name = String((req.body && req.body.name) || '').slice(0, 32);
    const version = String((req.body && req.body.version) || '').slice(0, 16);

    let u = store.get(hwid);
    if (!u) {
      u = store.set(hwid, {
        name, version,
        status: AUTO() ? 'approved' : 'pending',
        token: store.token(),
        firstSeen: Date.now(), lastSeen: Date.now(), notifiedAt: 0
      });
      store.log('register', hwid, name, { version });
      console.log('[api] nuevo HWID ' + hwid + ' (' + name + ')');
      pushNotify(u);
      return res.json({ ok: true, status: u.status, token: u.token, notified: true });
    }

    u = store.set(hwid, { name: name || u.name, version: version || u.version, lastSeen: Date.now() });

    /* si el usuario quedo pendiente y nunca se aviso (o el server se reinicio), re-avisamos */
    let notified = false;
    if (u.status === 'pending' && !u.notifiedAt) { pushNotify(u); notified = true; }

    if (u.status === 'blacklist') return res.json({ ok: true, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'denied')    return res.json({ ok: true, status: 'denied', reason: 'denied' });
    if (u.status === 'pending')   return res.json({ ok: true, status: 'pending', token: u.token, notified });
    return res.json({ ok: true, status: 'approved', token: u.token });
  });

  r.get('/verify', (req, res) => {
    const hwid = cleanHwid(req.query.hwid);
    const u = store.get(hwid);
    if (!u) return res.json({ ok: true, status: 'unknown' });

    const tok = String(req.query.token || '');
    if (u.token && tok && tok !== u.token) return res.json({ ok: true, status: 'pending', token: u.token, reason: 'bad_token' });

    store.set(hwid, { lastSeen: Date.now() });

    if (u.status === 'pending' && !u.notifiedAt) { pushNotify(u); }
    if (u.status === 'blacklist') return res.json({ ok: true, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'pending')   return res.json({ ok: true, status: 'pending' });
    if (u.status === 'denied')    return res.json({ ok: true, status: 'denied', reason: 'denied' });
    return res.json({ ok: true, status: 'approved', token: u.token });
  });

  r.get('/stats', (_q, res) => res.json({
    ok: true, total: store.list().length,
    approved: store.count('approved'), pending: store.count('pending'),
    denied: store.count('denied'), blacklist: store.count('blacklist')
  }));

  r.get('/logs', (q, res) => res.json({ ok: true, logs: store.logs(Math.min(200, Number(q.query.n) || 50)) }));

  return r;
};