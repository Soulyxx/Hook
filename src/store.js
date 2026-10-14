'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.file = null; this.writable = false; this._mtime = 0; this._lastFlush = 0;
    this.db = { users: {}, logs: [], meta: {} };

    const candidates = [dir, path.join(process.cwd(), 'data'), path.join(os.tmpdir(), 'hook-slx')];
    for (const c of candidates) {
      try {
        fs.mkdirSync(c, { recursive: true });
        fs.accessSync(c, fs.constants.W_OK);
        this.file = path.join(c, 'db.json'); this.dir = c; this.writable = true;
        break;
      } catch (e) { console.warn('[store] ' + c + ' no usable: ' + e.message); }
    }
    if (!this.file) { this.dir = os.tmpdir(); this.file = path.join(this.dir, 'hook-slx-db.json'); }
    console.log('[store] base -> ' + this.file + (this.writable ? '' : '  <<< SOLO LECTURA: monta un Volume en /data'));

    this.load();
    this.instance = this.metaGet('instanceId');
    if (!this.instance) { this.instance = crypto.randomBytes(6).toString('hex'); this.metaSet('instanceId', this.instance); }
    console.log('[store] instancia ' + this.instance);

    this._t = setInterval(() => { if (this._dirty) this.flush(); }, 2000);
    if (this._t.unref) this._t.unref();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db = { users: (raw && raw.users) || {}, logs: (raw && raw.logs) || [], meta: (raw && raw.meta) || {} };
      this._mtime = fs.statSync(this.file).mtimeMs;
    } catch { /* primera vez */ }
  }

  /* si otro proceso escribio la base, la recargamos */
  syncFromDisk() {
    if (!this.writable) return false;
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs <= this._mtime + 1) return false;
      if (Date.now() - this._lastFlush < 1200) return false;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db = { users: (raw && raw.users) || {}, logs: (raw && raw.logs) || [], meta: (raw && raw.meta) || {} };
      this._mtime = st.mtimeMs;
      console.log('[store] base recargada desde disco (' + Object.keys(this.db.users).length + ' usuarios)');
      return true;
    } catch { return false; }
  }

  flush() {
    if (!this.writable) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false; this._lastFlush = Date.now();
      try { this._mtime = fs.statSync(this.file).mtimeMs; } catch {}
    } catch (e) { console.error('[store] flush:', e.message); }
  }
  touch() { this._dirty = true; }

  get(hwid) { return this.db.users[hwid]; }
  set(hwid, patch) {
    this.db.users[hwid] = Object.assign({ hwid, created: Date.now() }, this.db.users[hwid] || {}, patch);
    this.touch(); this.flush();
    return this.db.users[hwid];
  }
  ensure(hwid, extra) {
    return this.get(hwid) || this.set(hwid, Object.assign({ status: 'pending', name: 'manual', version: '-', token: this.token(), notifiedAt: 0 }, extra || {}));
  }
  remove(hwid) { delete this.db.users[hwid]; this.touch(); this.flush(); }
  list() { return Object.values(this.db.users).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)); }
  count(status) { return this.list().filter((u) => u.status === status).length; }
  token() { return crypto.randomBytes(24).toString('hex'); }

  log(type, hwid, by, extra) {
    this.db.logs.unshift({ t: Date.now(), type, hwid: hwid || null, by: by || null, extra: extra || null });
    if (this.db.logs.length > 2000) this.db.logs.length = 2000;
    this.touch();
    return this.db.logs[0];
  }
  logs(n = 20) { return this.db.logs.slice(0, n); }

  metaGet(k, d = null) { return k in this.db.meta ? this.db.meta[k] : d; }
  metaSet(k, v) { this.db.meta[k] = v; this.touch(); this.flush(); return v; }
  metaDel(k) { delete this.db.meta[k]; this.touch(); this.flush(); }
}

module.exports = { Store };