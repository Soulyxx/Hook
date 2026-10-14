'use strict';
/* node diagnose.js  (usa las mismas variables de entorno que Railway) */
const fs = require('fs');
const path = require('path');

/* cargar .env si existe, sin dependencias */
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
})();

const { Client, GatewayIntentBits, Events, PermissionFlagsBits, ChannelType } = require('discord.js');
const { sanitizeToken, tokenBotId } = require('./src/bot');

const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => console.log('  FAIL ' + m);
const warn = (m) => console.log('  WARN ' + m);

(async () => {
  console.log('\n=== Hook Slx Auth - diagnostico ===\n');

  const raw = process.env.DISCORD_TOKEN;
  if (!raw) { bad('DISCORD_TOKEN vacio'); process.exit(1); }

  const token = sanitizeToken(raw);
  if (token !== raw) warn('el token tenia espacios/saltos de linea -> hay que limpiarlo en Railway');
  const id = tokenBotId(token);
  if (!id) { bad('el token no decodifica a un id -> token malformado o de otra cosa'); process.exit(1); }
  ok('token valido, bot id ' + id);

  const OWNER = String(process.env.OWNER_ID || '').trim();
  const CHAN = String(process.env.PANEL_CHANNEL_ID || '').trim();
  OWNER ? ok('OWNER_ID ' + OWNER) : warn('OWNER_ID vacio');
  CHAN ? ok('PANEL_CHANNEL_ID ' + CHAN) : warn('PANEL_CHANNEL_ID vacio (se autodetectara)');
  process.env.AUTH_SECRET ? ok('AUTH_SECRET presente') : warn('AUTH_SECRET vacio (gate abierto)');

  /* --- 1) login con Guilds solo (no privilegiado) --- */
  const c = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await c.login(token);
    await new Promise((r) => c.once(Events.ClientReady, r));
    ok('login OK -> ' + c.user.tag + ' (' + c.user.id + ')');
  } catch (e) {
    bad('login fallo: ' + e.message);
    if (/token/i.test(e.message)) console.log('       -> token invalido/reseteado en el portal');
    process.exit(1);
  }

  /* --- 2) guilds --- */
  console.log('\n--- servidores ---');
  if (c.guilds.cache.size === 0) { bad('el bot no esta en ningun servidor'); }
  for (const g of c.guilds.cache.values()) {
    const me = g.members.me;
    console.log('  guild ' + g.name + ' (' + g.id + ')');
    console.log('    permisos: ' + (me.permissions.has(PermissionFlagsBits.Administrator) ? 'Administrator' :
      me.permissions.toArray().slice(0, 8).join(', ') + '…'));
    try {
      const cmds = await g.commands.fetch();
      ok('scope applications.commands presente (' + cmds.size + ' comandos)');
    } catch (e) {
      bad('no puedo leer comandos del guild: ' + e.message);
      if (e.code === 50001 || e.status === 403) console.log('       -> REINVITA el bot con scope applications.commands');
    }
  }

  /* --- 3) canal del panel --- */
  console.log('\n--- canal del panel ---');
  if (CHAN) {
    const ch = await c.channels.fetch(CHAN).catch((e) => { bad('canal ' + CHAN + ': ' + e.message); return null; });
    if (ch) {
      ok('canal #' + ch.name + ' en "' + (ch.guild ? ch.guild.name : '?') + '"');
      const perms = ch.permissionsFor(ch.guild.members.me);
      const need = [['Send Messages', PermissionFlagsBits.SendMessages], ['Embed Links', PermissionFlagsBits.EmbedLinks], ['Pin Messages', PermissionFlagsBits.PinMessages]];
      for (const [n, f] of need) perms.has(f) ? ok('permiso ' + n) : bad('falta permiso ' + n);
    }
  } else {
    const names = ['hook-slx', 'panel', 'auth', 'accesos'];
    const f = [...c.guilds.cache.values()].flatMap((g) => [...g.channels.cache.values()])
      .find((x) => x.type === ChannelType.GuildText && names.includes(x.name.toLowerCase()));
    f ? ok('autodetectado #' + f.name) : warn('no hay canal #hook-slx -> crea uno o usa /setup');
  }

  /* --- 4) owner --- */
  if (OWNER) {
    console.log('\n--- owner ---');
    const u = await c.users.fetch(OWNER).catch(() => null);
    u ? ok('owner ' + u.tag) : bad('OWNER_ID ' + OWNER + ' no resuelve');
  }

  console.log('\n=== fin. Si todo esta OK, el bot arrancara solo. ===\n');
  c.destroy();
  process.exit(0);
})().catch((e) => { console.error('\nEXCEPCION: ' + e.message); process.exit(1); });