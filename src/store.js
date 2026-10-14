'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.file = null;
    this.writable = false;
    this.db = { users: {}, logs: [], meta: {} };

    const candidates = [dir, path.join(process.cwd(), 'data'), path.join(os.tmpdir(), 'hook-slx')];
    for (const c of candidates) {
      try {
        fs.mkdirSync(c, { recursive: true });
        const f = path.join(c, 'db.json');
        fs.accessSync(c, fs.constants.W_OK);
        this.file = f; this.dir = c; this.writable = true;
        break;
      } catch (e) { console.warn('[store] ' + c + ' no usable: ' + e.message); }
    }
    if (!this.file) { this.dir = os.tmpdir(); this.file = path.join(this.dir, 'hook-slx-db.json'); }
    console.log('[store] base -> ' + this.file + (this.writable ? '' : ' (SOLO LECTURA - revisa el Volume)'));

    this.load();
    this._dirty = false;
    this._t = setInterval(() => { if (this._dirty) this.flush(); }, 2000);
    if (this._t.unref) this._t.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db = {
        users: (raw && raw.users) || {},
        logs: (raw && raw.logs) || [],
        meta: (raw && raw.meta) || {}
      };
      console.log('[store] ' + Object.keys(this.db.users).length + ' usuarios cargados');
    } catch { this.db = { users: {}, logs: [], meta: {} }; }
  }

  flush() {
    if (!this.writable) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (e) { console.error('[store] flush:', e.message); }
  }
  touch() { this._dirty = true; }

  /* ---- usuarios ---- */
  get(hwid) { return this.db.users[hwid]; }
  set(hwid, patch) {
    this.db.users[hwid] = Object.assign({ hwid, created: Date.now() }, this.db.users[hwid] || {}, patch);
    this.touch(); this.flush();
    return this.db.users[hwid];
  }
  remove(hwid) { delete this.db.users[hwid]; this.touch(); this.flush(); }
  list() { return Object.values(this.db.users).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)); }
  count(status) { return this.list().filter((u) => u.status === status).length; }
  token() { return crypto.randomBytes(24).toString('hex'); }

  /* ---- auditoria ---- */
  log(type, hwid, by, extra) {
    this.db.logs.unshift({ t: Date.now(), type, hwid: hwid || null, by: by || null, extra: extra || null });
    if (this.db.logs.length > 2000) this.db.logs.length = 2000;
    this.touch();
    return this.db.logs[0];
  }
  logs(n = 20) { return this.db.logs.slice(0, n); }

  /* ---- meta ---- */
  metaGet(k, d = null) { return k in this.db.meta ? this.db.meta[k] : d; }
  metaSet(k, v) { this.db.meta[k] = v; this.touch(); return v; }
  metaDel(k) { delete this.db.meta[k]; this.touch(); }
}

module.exports = { Store };