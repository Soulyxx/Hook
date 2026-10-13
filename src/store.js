'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.db = { users: {} };
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    this.load();
    this._t = setInterval(() => this.flush(), 4000);
    if (this._t.unref) this._t.unref();
  }
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.db = raw && raw.users ? raw : { users: {} };
    } catch { this.db = { users: {} }; }
  }
  flush() {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] flush', e.message); }
  }
  get(hwid) { return this.db.users[hwid]; }
  set(hwid, patch) {
    this.db.users[hwid] = Object.assign({ hwid, created: Date.now() }, this.db.users[hwid] || {}, patch);
    this.flush();
    return this.db.users[hwid];
  }
  remove(hwid) { delete this.db.users[hwid]; this.flush(); }
  list() { return Object.values(this.db.users); }
  token() { return crypto.randomBytes(24).toString('hex'); }
}

module.exports = { Store };