'use strict';
const express = require('express');
const crypto = require('crypto');

const cleanHwid = (v) => String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 64);

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

  /* sin gate: identifica el servidor y si exige secret */
  r.get('/ping', (_q, res) => res.json({
    ok: true, service: 'hook-slx-auth', version: '3.0.0',
    instanceId: store.instance, users: store.list().length,
    secretRequired: !!secret, time: Date.now()
  }));

  r.use(gate(secret));

  const markNotified = (hwid) => store.set(hwid, { notifiedAt: Date.now() });

  function fire(u) {
    if (!notify) return;
    markNotified(u.hwid);
    try { notify('new', store.get(u.hwid)); } catch (e) { console.error('[api] notify:', e.message); }
  }

  r.post('/hello', (req, res) => {
    const hwid = cleanHwid(req.body && req.body.hwid);
    if (hwid.length < 8) return res.status(400).json({ ok: false, error: 'bad_hwid', got: hwid });
    const name = String((req.body && req.body.name) || '').slice(0, 32);
    const version = String((req.body && req.body.version) || '').slice(0, 16);

    let u = store.get(hwid);
    if (!u) {
      u = store.set(hwid, {
        name, version, status: AUTO() ? 'approved' : 'pending',
        token: store.token(), firstSeen: Date.now(), lastSeen: Date.now(), notifiedAt: 0
      });
      store.log('register', hwid, name, { version });
      console.log('[api] NUEVO hwid=' + hwid + ' name=' + name + ' instancia=' + store.instance);
      fire(u);
      return res.json({ ok: true, status: u.status, token: u.token, notified: true, instanceId: store.instance });
    }

    u = store.set(hwid, { name: name || u.name, version: version || u.version, lastSeen: Date.now() });
    let notified = false;
    if (u.status === 'pending' && !u.notifiedAt) { fire(u); notified = true; }

    const base = { ok: true, instanceId: store.instance };
    if (u.status === 'blacklist') return res.json({ ...base, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'denied')    return res.json({ ...base, status: 'denied', reason: 'denied' });
    if (u.status === 'pending')   return res.json({ ...base, status: 'pending', token: u.token, notified });
    return res.json({ ...base, status: 'approved', token: u.token });
  });

  r.get('/verify', (req, res) => {
    const hwid = cleanHwid(req.query.hwid);
    const u = store.get(hwid);
    if (!u) return res.json({ ok: true, status: 'unknown', instanceId: store.instance });
    const tok = String(req.query.token || '');
    if (u.token && tok && tok !== u.token) return res.json({ ok: true, status: 'pending', token: u.token, reason: 'bad_token' });
    store.set(hwid, { lastSeen: Date.now() });
    if (u.status === 'pending' && !u.notifiedAt) fire(u);
    const base = { ok: true, instanceId: store.instance };
    if (u.status === 'blacklist') return res.json({ ...base, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'pending')   return res.json({ ...base, status: 'pending' });
    if (u.status === 'denied')    return res.json({ ...base, status: 'denied', reason: 'denied' });
    return res.json({ ...base, status: 'approved', token: u.token });
  });

  /* mismo contenido que /diag del bot: sirve para comparar */
  r.get('/whoami', (_q, res) => res.json({
    ok: true, instanceId: store.instance, db: store.file, writable: store.writable,
    users: store.list().length, pending: store.count('pending'), panel: store.metaGet('panelChannelId')
  }));

  r.get('/stats', (_q, res) => res.json({
    ok: true, instanceId: store.instance, total: store.list().length,
    approved: store.count('approved'), pending: store.count('pending'),
    denied: store.count('denied'), blacklist: store.count('blacklist')
  }));

  r.get('/logs', (q, res) => res.json({ ok: true, logs: store.logs(Math.min(200, Number(q.query.n) || 50)) }));

  return r;
};