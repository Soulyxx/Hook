'use strict';
const fs = require('fs');
const path = require('path');

function findEntry() {
  const direct = ['src/index.js', 'app/index.js', 'server.js'];
  for (const d of direct) { const p = path.join(__dirname, d); if (fs.existsSync(p)) return p; }
  for (const name of fs.readdirSync(__dirname)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const dir = path.join(__dirname, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const f of ['index.js', path.join('src', 'index.js')]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const entry = findEntry();
if (!entry) {
  console.error('[boot] NO encontre entrypoint en ' + __dirname);
  try { console.error('[boot] contenido: ' + fs.readdirSync(__dirname).join(', ')); } catch {}
  process.exit(1);
}
console.log('[boot] entrypoint -> ' + path.relative(__dirname, entry));
require(entry);