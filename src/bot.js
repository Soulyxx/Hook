'use strict';
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, ChannelType, PermissionFlagsBits
} = require('discord.js');

const HWID_RE = /^[A-Z0-9]{8,64}$/;
const clean = (s) => String(s || '-').replace(/`/g, "'").slice(0, 60);
const short = (h) => String(h || '').slice(0, 8);

function sanitizeToken(t) { return String(t || '').replace(/\s+/g, '').replace(/^Bot/i, ''); }
function tokenBotId(tok) {
  try {
    const b = Buffer.from(tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^\d{15,21}$/.test(b) ? b : null;
  } catch { return null; }
}

const hwidOption = (o) => o.setName('hwid').setDescription('HWID').setRequired(true).setAutocomplete(true);

const COMMANDS = [
  new SlashCommandBuilder().setName('panel').setDescription('Envia el panel'),
  new SlashCommandBuilder().setName('setup').setDescription('Fija el canal de logs')
    .addChannelOption((o) => o.setName('canal').setDescription('Canal').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('pending').setDescription('Pendientes'),
  new SlashCommandBuilder().setName('users').setDescription('Todos'),
  new SlashCommandBuilder().setName('active').setDescription('Aprobados'),
  new SlashCommandBuilder().setName('blacklist').setDescription('Blacklist'),
  new SlashCommandBuilder().setName('stats').setDescription('Estadisticas'),
  new SlashCommandBuilder().setName('logs').setDescription('Ultimos eventos'),
  new SlashCommandBuilder().setName('diag').setDescription('Diagnostico'),
  new SlashCommandBuilder().setName('find').setDescription('Buscar')
    .addStringOption((o) => o.setName('texto').setDescription('Texto').setRequired(true)),
  new SlashCommandBuilder().setName('add').setDescription('Crea un HWID a mano').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('repost').setDescription('Reenvia la solicitud').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('accept').setDescription('Aprobar').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('deny').setDescription('Denegar').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('reset').setDescription('Volver a pendiente').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('black').setDescription('Blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('unblack').setDescription('Sacar de blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('remove').setDescription('Borrar').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('sync').setDescription('Recrear el panel'),
  new SlashCommandBuilder().setName('help').setDescription('Ayuda')
];

function panelEmbed(store) {
  const c = (s) => store.count(s);
  return new EmbedBuilder()
    .setTitle('Hook Slx — Access Panel')
    .setDescription([
      `Instancia: \`${store.instance}\``,
      `Total: **${store.list().length}**`,
      `Aprobados: **${c('approved')}**`,
      `Pendientes: **${c('pending')}**`,
      `Denegados: **${c('denied')}**`,
      `Blacklist: **${c('blacklist')}**`
    ].join('\n'))
    .setColor(0x3ea6ff).setFooter({ text: 'Hook Slx Auth • panel' }).setTimestamp(new Date());
}

function userEmbed(u, done) {
  const color = u.status === 'approved' ? 0x22c26e : (u.status === 'denied' || u.status === 'blacklist') ? 0xff4d5e : 0xf0a72c;
  return new EmbedBuilder()
    .setTitle(done ? 'Hook Slx — Solicitud decidida' : 'Hook Slx — Nueva solicitud')
    .addFields(
      { name: 'HWID', value: '`' + u.hwid + '`' },
      { name: 'Usuario', value: clean(u.name), inline: true },
      { name: 'Version', value: clean(u.version), inline: true },
      { name: 'Estado', value: String(u.status || 'pending'), inline: true }
    )
    .setColor(color)
    .setFooter({ text: done ? 'por ' + (u.decidedBy || '-') : 'Hook Slx Auth' })
    .setTimestamp(new Date(u.decidedAt || u.created || Date.now()));
}

function userButtons(hwid, done) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc:' + hwid).setLabel('Aceptar').setStyle(ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId('den:' + hwid).setLabel('Denegar').setStyle(ButtonStyle.Danger).setDisabled(!!done),
    new ButtonBuilder().setCustomId('blk:' + hwid).setLabel('Blacklist').setStyle(ButtonStyle.Secondary).setDisabled(!!done)
  );
}

function startBot(store) {
  const TOKEN  = sanitizeToken(process.env.DISCORD_TOKEN);
  const OWNER  = String(process.env.OWNER_ID || '').trim();
  const ADMINS = String(process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

  if (!TOKEN) { console.warn('[bot] sin DISCORD_TOKEN'); return Promise.resolve(null); }
  console.log('[bot] token -> bot id ' + (tokenBotId(TOKEN) || 'DESCONOCIDO'));

  const state = { online: false, tag: null, id: tokenBotId(TOKEN), guilds: 0, panel: null, lastError: null, intents: 'Guilds' };
  let client = null;
  let wantMsgContent = String(process.env.PREFIX_COMMANDS || 'false') === 'true';
  let panelTimer = null;

  const isStaff = (m) => {
    if (!m) return false;
    if (m.id === OWNER || ADMINS.includes(m.id)) return true;
    if (!OWNER && m.permissions && m.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
    return false;
  };

  async function resolveChannel(force = false) {
    if (!force) {
      const cached = store.metaGet('panelChannelId');
      if (cached) { const ch = await client.channels.fetch(cached).catch(() => null); if (ch && ch.isTextBased()) return ch; }
    }
    const envId = String(process.env.PANEL_CHANNEL_ID || '').trim();
    if (envId) {
      const ch = await client.channels.fetch(envId).catch((e) => { console.warn('[bot] canal ' + envId + ': ' + e.message); return null; });
      if (ch && ch.isTextBased()) { store.metaSet('panelChannelId', ch.id); return ch; }
    }
    const names = ['logs-hook', 'hook-logs', 'hook-slx', 'hookslx', 'panel', 'auth', 'accesos'];
    for (const g of client.guilds.cache.values()) {
      const f = g.channels.cache.find((c) => c.isTextBased() && names.includes(c.name.toLowerCase()));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] canal auto -> #' + f.name); return f; }
    }
    for (const g of client.guilds.cache.values()) {
      const me = g.members.me;
      const f = g.channels.cache.find((c) => c.type === ChannelType.GuildText && me &&
        c.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] canal auto -> #' + f.name); return f; }
    }
    return null;
  }

  const refreshPanel = (force = false) => {
    clearTimeout(panelTimer);
    panelTimer = setTimeout(() => ensurePanel(force).catch(() => {}), 600);
  };

  async function ensurePanel(force = false) {
    const ch = await resolveChannel(force);
    if (!ch) { console.warn('[bot] sin canal de logs'); return null; }
    state.panel = ch.id;
    const mid = store.metaGet('panelMessageId');
    if (mid && !force) {
      const m = await ch.messages.fetch(mid).catch(() => null);
      if (m) { await m.edit({ embeds: [panelEmbed(store)] }).catch(() => {}); return m; }
    }
    const m = await ch.send({ embeds: [panelEmbed(store)] }).catch((e) => { console.error('[bot] panel:', e.message); return null; });
    if (m) { store.metaSet('panelMessageId', m.id); m.pin().catch(() => {}); }
    return m;
  }

  async function notifyNew(u) {
    if (!state.online) return null;
    const ch = await resolveChannel();
    if (!ch) { console.error('[bot] sin canal -> ' + u.hwid + ' sin notificar'); return null; }
    store.set(u.hwid, { notifiedAt: Date.now() });
    const m = await ch.send({
      content: OWNER ? `<@${OWNER}> nueva solicitud` : 'Nueva solicitud',
      embeds: [userEmbed(u, false)],
      components: [userButtons(u.hwid, false)]
    }).catch((e) => { console.error('[bot] notify:', e.message); return null; });
    if (m) { store.set(u.hwid, { notifyMessageId: m.id }); console.log('[bot] log enviado ' + u.hwid); refreshPanel(); }
    return m;
  }

  /* ---- SWEEPER: publica cualquier pendiente sin aviso, pase lo que pase ---- */
  async function sweep() {
    if (!state.online) return;
    try {
      store.syncFromDisk();
      const pend = store.list().filter((u) => u.status === 'pending' && !u.notifiedAt);
      for (const u of pend.slice(0, 6)) {
        await notifyNew(u);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) { console.error('[bot] sweep:', e.message); }
  }

  async function registerIn(guild) {
    try { await guild.commands.set(COMMANDS.map((c) => c.toJSON())); console.log('[bot] comandos OK en "' + guild.name + '"'); }
    catch (e) {
      if (e.code === 50001 || e.status === 403) console.error('[bot] FALTA scope applications.commands en "' + guild.name + '"');
      else console.error('[bot] registrar en "' + guild.name + '": ' + e.message);
    }
  }
  const registerAll = async () => { for (const g of client.guilds.cache.values()) await registerIn(g); };

  function attach(c) {
    c.on(Events.Error, (e) => { state.lastError = e.message; console.error('[bot] error:', e.message); });
    c.on(Events.Warn, (m) => console.warn('[bot] warn:', m));
    c.on(Events.ShardDisconnect, (e, id) => console.warn('[bot] shard ' + id + ' caido (' + e.code + ')'));
    c.on(Events.ShardError, (e) => { state.lastError = e.message; console.error('[bot] shard:', e.message); });
    c.on(Events.Invalidated, () => { state.online = false; console.error('[bot] SESION INVALIDADA'); });

    c.once(Events.ClientReady, async (me) => {
      state.online = true; state.tag = me.user.tag; state.id = me.user.id; state.guilds = c.guilds.cache.size;
      console.log('[bot] ONLINE como ' + me.user.tag + ' en ' + state.guilds + ' guild(s)');
      console.log('[bot] instancia de base: ' + store.instance + ' @ ' + store.file);
      await registerAll();
      await ensurePanel();
      await sweep();
      setInterval(sweep, 4000);
      if (OWNER) { const o = await c.users.fetch(OWNER).catch(() => null); if (!o) console.warn('[bot] OWNER_ID no resuelve'); }
    });

    c.on(Events.GuildCreate, async (g) => { await registerIn(g); if (!store.metaGet('panelChannelId')) await ensurePanel(true); });

    c.on(Events.InteractionCreate, async (i) => {
      try {
        if (i.isAutocomplete()) {
          const q = String(i.options.getFocused() || '').toUpperCase();
          const pool = ['accept', 'deny', 'reset', 'black'].includes(i.commandName)
            ? store.list().filter((u) => u.status !== 'approved') : store.list();
          return i.respond(pool.filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q))
            .slice(0, 25).map((u) => ({ name: `${short(u.hwid)}… · ${clean(u.name)} · ${u.status}`, value: u.hwid })));
        }

        const staff = i.member ? isStaff({ id: i.user.id, permissions: i.member.permissions }) : (i.user.id === OWNER);

        if (i.isButton()) {
          if (!staff) return i.reply({ content: 'Solo el owner.', ephemeral: true });
          const [act, hwid] = i.customId.split(':');
          store.ensure(hwid);
          const map = { acc: 'approved', den: 'denied', blk: 'blacklist' };
          store.set(hwid, { status: map[act], decidedAt: Date.now(), decidedBy: i.user.tag });
          store.log(map[act], hwid, i.user.tag);
          console.log('[bot] ' + map[act] + ' ' + hwid + ' por ' + i.user.tag);
          await i.update({ embeds: [userEmbed(store.get(hwid), true)], components: [userButtons(hwid, true)] }).catch(() => {});
          refreshPanel();
          return;
        }

        if (!i.isChatInputCommand()) return;
        const say = (p) => i.reply(typeof p === 'string' ? { content: p, ephemeral: true } : { ...p, ephemeral: true });
        const hwid = String(i.options.getString('hwid') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

        if (i.commandName === 'help') {
          return say(['**Hook Slx Auth**', '`/panel` `/setup #canal` `/sync` `/diag` `/stats` `/logs`',
            '`/pending` `/users` `/active` `/blacklist` `/find` `/add` `/repost`',
            '`/accept` `/deny` `/reset` `/black` `/unblack` `/remove`'].join('\n'));
        }

if (i.commandName === 'diag') {
          const ch = await resolveChannel();
          return say({ embeds: [new EmbedBuilder().setTitle('Diagnostico')
            .addFields(
              { name: 'Bot', value: `${state.tag} (\`${state.id}\`)`, inline: true },
              { name: 'Online', value: String(state.online), inline: true },
              { name: 'Guilds', value: String(state.guilds), inline: true },
              { name: 'Instancia', value: '`' + store.instance + '`', inline: true },
              { name: 'Dominio', value: '`' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'sin RAILWAY_PUBLIC_DOMAIN') + '`', inline: false },
              { name: 'Base', value: '`' + (store.file || '-') + '`', inline: false },
              { name: 'Escribible', value: String(store.writable), inline: true },
              { name: 'Usuarios', value: String(store.list().length), inline: true },
              { name: 'Canal', value: ch ? '<#' + ch.id + '>' : 'no resuelto', inline: true },
              { name: 'Ultimo error', value: state.lastError ? String(state.lastError).slice(0, 110) : 'ninguno' }
            ).setColor(0x3ea6ff).setTimestamp(new Date())] });
        }

        if (!staff) return say('Solo el owner.');

        switch (i.commandName) {
          case 'panel': { const ch = await resolveChannel(); if (!ch) return say('Sin canal. `/setup`.'); await ch.send({ embeds: [panelEmbed(store)] }); return say('Panel enviado.'); }
          case 'setup': {
            const ch = i.options.getChannel('canal') || i.channel;
            if (!ch || !ch.isTextBased()) return say('Canal invalido.');
            store.metaSet('panelChannelId', ch.id); store.metaDel('panelMessageId');
            await ensurePanel(true); return say('Canal de logs: <#' + ch.id + '>.');
          }
          case 'sync': await ensurePanel(true); return say('Panel recreado.');
          case 'logs': { const l = store.logs(20); return say(l.length ? l.map((x) => `\`${new Date(x.t).toISOString().slice(11, 19)}\` **${x.type}** ${x.hwid ? '`' + short(x.hwid) + '…`' : ''} ${x.by || ''}`).join('\n') : 'Sin eventos.'); }
          case 'stats': {
            const c2 = (s) => store.count(s);
            return say({ embeds: [new EmbedBuilder().setTitle('Estadisticas')
              .setDescription(`Instancia \`${store.instance}\`\nTotal **${store.list().length}** · Aprobados **${c2('approved')}** · Pendientes **${c2('pending')}** · Denegados **${c2('denied')}** · Blacklist **${c2('blacklist')}**`)
              .setColor(0x3ea6ff)] });
          }
          case 'add': {
            if (!HWID_RE.test(hwid)) return say('HWID invalido.');
            const existed = !!store.get(hwid);
            store.ensure(hwid, { name: 'manual', version: '-' });
            await notifyNew(store.get(hwid));
            return say((existed ? 'Ya existia, reenviado: ' : 'Creado: ') + hwid);
          }
          case 'repost': {
            if (!store.get(hwid)) return say('No existe. Usa `/add`.');
            store.set(hwid, { notifiedAt: 0 });
            await notifyNew(store.get(hwid));
            return say('Reenviado: ' + hwid);
          }
          case 'pending': { const l = store.list().filter((u) => u.status === 'pending'); return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)}`).join('\n') : 'Nada pendiente.'); }
          case 'users': { const l = store.list().slice(0, 40); return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${u.status} · ${clean(u.name)}`).join('\n') : 'Vacio.'); }
          case 'active': { const l = store.list().filter((u) => u.status === 'approved'); return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)}`).join('\n') : 'Vacio.'); }
          case 'blacklist': { const l = store.list().filter((u) => u.status === 'blacklist'); return say(l.length ? l.map((u) => `\`${u.hwid}\``).join('\n') : 'Vacio.'); }
          case 'find': {
            const q = String(i.options.getString('texto') || '').toUpperCase();
            const l = store.list().filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q)).slice(0, 30);
            return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)} · ${u.status}`).join('\n') : 'Nada.');
          }
          case 'accept': case 'deny': case 'reset': case 'black': case 'unblack': case 'remove': {
            if (!HWID_RE.test(hwid)) return say('HWID invalido: ' + (hwid || '(vacio)'));
            if (i.commandName === 'remove') { store.remove(hwid); store.log('remove', hwid, i.user.tag); return say('Borrado: ' + hwid); }
            store.ensure(hwid, { name: 'manual', version: '-' });
            const st = { accept: 'approved', deny: 'denied', reset: 'pending', black: 'blacklist', unblack: 'pending' }[i.commandName];
            store.set(hwid, { status: st, decidedAt: Date.now(), decidedBy: i.user.tag });
            store.log(i.commandName, hwid, i.user.tag);
            if (st === 'pending') store.set(hwid, { notifiedAt: 0 });
            refreshPanel();
            return say('OK: ' + i.commandName + ' ' + hwid + ' (instancia ' + store.instance + ')');
          }
        }
      } catch (e) {
        console.error('[bot] interaction:', e.message);
        try {
          if (i.deferred || i.replied) i.followUp({ content: 'Error: ' + e.message, ephemeral: true });
          else i.reply({ content: 'Error: ' + e.message, ephemeral: true });
        } catch {}
      }
    });
  }

  function build(withMsg) {
    const intents = [GatewayIntentBits.Guilds];
    if (withMsg) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    state.intents = withMsg ? 'Guilds+GuildMessages+MessageContent' : 'Guilds';
    const c = new Client({ intents });
    attach(c);
    return c;
  }

  async function connect() {
    client = build(wantMsgContent);
    try { await client.login(TOKEN); }
    catch (e) {
      state.lastError = e.message;
      if (/disallowed intents/i.test(e.message) && wantMsgContent) {
        try { client.destroy(); } catch {}
        wantMsgContent = false; client = build(false); await client.login(TOKEN);
      } else throw e;
    }
  }

  let tries = 0;
  async function boot() {
    try { await connect(); }
    catch (e) {
      state.lastError = e.message; tries++;
      const wait = Math.min(60000, 4000 * tries);
      if (tries <= 10) { console.error('[bot] login fallo (' + tries + '/10): ' + e.message); setTimeout(boot, wait); }
      else console.error('[bot] login abandonado -> npm run diagnose');
    }
  }
  boot();

  return Promise.resolve({ notifyNew, status: () => state, isOnline: () => state.online, guilds: () => state.guilds, client: () => client });
}

module.exports = { startBot, sanitizeToken, tokenBotId };