'use strict';
const express = require('express');
const crypto = require('crypto');

function gate(secret) {
  const sb = Buffer.from(String(secret));
  return (req, res, next) => {
    if (!secret) return next();
    const got = Buffer.from(String(req.get('x-auth-secret') || req.query.k || ''));
    if (got.length === sb.length && crypto.timingSafeEqual(got, sb)) return next();
    return res.status(401).json({ ok: false, error: 'bad_secret' });
  };
}

module.exports = function apiRouter(store, secret, notify) {
  const r = express.Router();
  r.use(gate(secret));

  r.post('/hello', (req, res) => {
    const hwid = String((req.body && req.body.hwid) || '').toUpperCase();
    if (hwid.length < 8) return res.status(400).json({ ok: false, error: 'bad_hwid' });
    const name = String((req.body && req.body.name) || '').slice(0, 32);
    const version = String((req.body && req.body.version) || '').slice(0, 16);

    let u = store.get(hwid);
    if (!u) {
      u = store.set(hwid, { name, version, status: 'pending', token: store.token(), lastSeen: Date.now() });
      if (notify) notify('new', u);
      return res.json({ ok: true, status: 'pending', token: u.token });
    }
    u = store.set(hwid, { name: name || u.name, version: version || u.version, lastSeen: Date.now() });
    if (u.status === 'blacklist') return res.json({ ok: true, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'denied') return res.json({ ok: true, status: 'denied', reason: 'denied' });
    if (u.status === 'pending') return res.json({ ok: true, status: 'pending', token: u.token });
    return res.json({ ok: true, status: 'approved', token: u.token });
  });

  r.get('/verify', (req, res) => {
    const hwid = String(req.query.hwid || '').toUpperCase();
    const u = store.get(hwid);
    if (!u) return res.json({ ok: true, status: 'unknown' });
    store.set(hwid, { lastSeen: Date.now() });
    if (u.status === 'blacklist') return res.json({ ok: true, status: 'denied', reason: 'blacklisted' });
    if (u.status === 'pending') return res.json({ ok: true, status: 'pending' });
    if (u.status === 'denied') return res.json({ ok: true, status: 'denied', reason: 'denied' });
    return res.json({ ok: true, status: 'approved', token: u.token });
  });

  return r;
};