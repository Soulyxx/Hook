const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');

let db = { users: {}, log: [] };
let dirty = false;

function load() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = { users: raw.users || {}, log: raw.log || [] };
  } catch { db = { users: {}, log: [] }; }
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
function touch() { dirty = true; }
setInterval(() => { if (dirty) { dirty = false; try { save(); } catch {} } }, 4000);

function log(msg) {
  db.log.unshift({ t: Date.now(), msg });
  db.log = db.log.slice(0, 400);
  touch();
}

function get(hwid) { return db.users[hwid] || null; }
function byName(q) {
  q = String(q || '').toLowerCase();
  return Object.values(db.users).filter((u) =>
    u.hwid.toLowerCase().includes(q) || (u.pc || '').toLowerCase().includes(q) || (u.user || '').toLowerCase().includes(q));
}
function all() { return Object.values(db.users); }
function pending() { return all().filter((u) => u.status === 'pending'); }
function approved() { return all().filter((u) => u.status === 'approved'); }
function blacklist() { return all().filter((u) => u.status === 'blacklisted'); }
function active(withinMs = 120000) { return approved().filter((u) => Date.now() - (u.lastSeen || 0) < withinMs); }

function upsert(hwid, data) {
  let u = db.users[hwid];
  if (!u) {
    u = { hwid, status: 'pending', createdAt: Date.now(), token: newToken(), sessions: 0 };
    db.users[hwid] = u;
  }
  Object.assign(u, data, { hwid, lastSeen: Date.now() });
  touch();
  return u;
}
function newToken() { return crypto.randomBytes(20).toString('hex'); }
function setStatus(hwid, status) {
  const u = db.users[hwid];
  if (!u) return null;
  u.status = status;
  if (status === 'approved') { u.token = newToken(); u.approvedAt = Date.now(); }
  touch();
  log(`${status}: ${u.pc || u.hwid}`);
  return u;
}
function remove(hwid) { const u = db.users[hwid]; delete db.users[hwid]; touch(); log('removed: ' + (u ? u.pc : hwid)); return u; }
function rotate(hwid) { const u = db.users[hwid]; if (!u) return null; u.token = newToken(); touch(); return u; }

module.exports = { load, save, get, all, byName, pending, approved, blacklist, active, upsert, setStatus, remove, rotate, log };