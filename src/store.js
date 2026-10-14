'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.db = { users: {}, meta: {} };
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { console.error('[store] no pude crear ' + dir + ': ' + e.message); }
    this.load();
    this._dirty = false;
    this._t = setInterval(() => { if (this._dirty) this.flush(); }, 4000);
    if (this._t.unref) this._t.unref();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db = { users: (raw && raw.users) || {}, meta: (raw && raw.meta) || {} };
    } catch { this.db = { users: {}, meta: {} }; }
  }
  flush() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (e) { console.error('[store] flush:', e.message); }
  }
  get(hwid) { return this.db.users[hwid]; }
  set(hwid, patch) {
    this.db.users[hwid] = Object.assign({ hwid, created: Date.now() }, this.db.users[hwid] || {}, patch);
    this._dirty = true;
    return this.db.users[hwid];
  }
  remove(hwid) { delete this.db.users[hwid]; this._dirty = true; this.flush(); }
  list() { return Object.values(this.db.users); }
  count(status) { return this.list().filter((u) => u.status === status).length; }
  token() { return crypto.randomBytes(24).toString('hex'); }
  metaGet(k, d = null) { return k in this.db.meta ? this.db.meta[k] : d; }
  metaSet(k, v) { this.db.meta[k] = v; this._dirty = true; return v; }
  metaDel(k) { delete this.db.meta[k]; this._dirty = true; }
}

module.exports = { Store };