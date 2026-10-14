'use strict';
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, ChannelType,
  PermissionFlagsBits, PermissionsBitField
} = require('discord.js');

const HWID_RE = /^[A-Z0-9]{8,64}$/;
const clean = (s) => String(s || '-').replace(/`/g, "'").slice(0, 60);
const short = (h) => h.slice(0, 8);

/* ============ utilidades de token ============ */
function sanitizeToken(t) {
  return String(t || '').replace(/\s+/g, '').replace(/^Bot/i, '');
}
function tokenBotId(tok) {
  try {
    const seg = tok.split('.')[0];
    const b = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^\d{15,21}$/.test(b) ? b : null;
  } catch { return null; }
}

/* ============ comandos ============ */
const hwidOption = (o) => o.setName('hwid').setDescription('HWID').setRequired(true).setAutocomplete(true);

const COMMANDS = [
  new SlashCommandBuilder().setName('panel').setDescription('Envia el panel de control'),
  new SlashCommandBuilder().setName('setup').setDescription('Fija el canal del panel')
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de texto').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('pending').setDescription('Solicitudes pendientes'),
  new SlashCommandBuilder().setName('users').setDescription('Todos los usuarios'),
  new SlashCommandBuilder().setName('active').setDescription('Usuarios aprobados'),
  new SlashCommandBuilder().setName('blacklist').setDescription('Blacklist'),
  new SlashCommandBuilder().setName('stats').setDescription('Estadisticas'),
  new SlashCommandBuilder().setName('diag').setDescription('Diagnostico del bot'),
  new SlashCommandBuilder().setName('find').setDescription('Buscar por HWID o nombre')
    .addStringOption((o) => o.setName('texto').setDescription('Texto').setRequired(true)),
  new SlashCommandBuilder().setName('accept').setDescription('Aprobar HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('deny').setDescription('Denegar HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('reset').setDescription('Volver a pendiente').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('black').setDescription('Mandar a blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('unblack').setDescription('Sacar de blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('remove').setDescription('Borrar HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('sync').setDescription('Recrear el panel'),
  new SlashCommandBuilder().setName('help').setDescription('Ayuda')
];

/* ============ embeds ============ */
function panelEmbed(store) {
  const c = (s) => store.count(s);
  return new EmbedBuilder()
    .setTitle('Hook Slx — Access Panel')
    .setDescription([
      `Total: **${store.list().length}**`,
      `Aprobados: **${c('approved')}**`,
      `Pendientes: **${c('pending')}**`,
      `Denegados: **${c('denied')}**`,
      `Blacklist: **${c('blacklist')}**`,
      '',
      'Usa los botones de cada solicitud, o `/accept`, `/deny`, `/black`.'
    ].join('\n'))
    .setColor(0x3ea6ff)
    .setFooter({ text: 'Hook Slx Auth • panel' })
    .setTimestamp(new Date());
}

function userEmbed(u, done) {
  const color = u.status === 'approved' ? 0x22c26e
    : (u.status === 'denied' || u.status === 'blacklist') ? 0xff4d5e : 0xf0a72c;
  return new EmbedBuilder()
    .setTitle(done ? 'Hook Slx — Solicitud (decidida)' : 'Hook Slx — Nueva solicitud')
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
    new ButtonBuilder().setCustomId('acc:' + hwid).setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId('den:' + hwid).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done),
    new ButtonBuilder().setCustomId('blk:' + hwid).setLabel('Blacklist').setStyle(ButtonStyle.Secondary).setDisabled(!!done)
  );
}

/* ============ bot ============ */
function startBot(store) {
  const TOKEN  = sanitizeToken(process.env.DISCORD_TOKEN);
  const OWNER  = String(process.env.OWNER_ID || '').trim();
  const ADMINS = String(process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

  if (!TOKEN) {
    console.warn('[bot] DISCORD_TOKEN ausente -> bot desactivado');
    return Promise.resolve(null);
  }

  const botId = tokenBotId(TOKEN);
  console.log('[bot] token decodifica a bot id: ' + (botId || 'DESCONOCIDO (token malformado)'));

  const state = {
    online: false, tag: null, id: botId, guilds: 0,
    panel: null, lastError: null, intents: 'Guilds'
  };

  let client = null;
  let wantMsgContent = String(process.env.PREFIX_COMMANDS || 'false') === 'true';
  const isStaff = (m) => {
    if (m.id === OWNER || ADMINS.includes(m.id)) return true;
    if (!OWNER && m.permissions && m.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
    return false;
  };

  /* ---------- canal del panel ---------- */
  async function resolveChannel(force = false) {
    if (!force) {
      const cached = store.metaGet('panelChannelId');
      if (cached) {
        const ch = await client.channels.fetch(cached).catch(() => null);
        if (ch && ch.isTextBased()) return ch;
      }
    }
    const envId = String(process.env.PANEL_CHANNEL_ID || '').trim();
    if (envId) {
      const ch = await client.channels.fetch(envId).catch((e) => {
        console.warn('[bot] PANEL_CHANNEL_ID ' + envId + ' no accesible: ' + e.message +
          (e.code === 10003 ? ' (canal inexistente o el bot no esta en ese server)' : ''));
        return null;
      });
      if (ch && ch.isTextBased()) { store.metaSet('panelChannelId', ch.id); return ch; }
    }
    const names = ['hook-slx', 'hookslx', 'hook-slx-panel', 'panel', 'auth', 'accesos'];
    for (const g of client.guilds.cache.values()) {
      const f = g.channels.cache.find((c) => c.isTextBased() && names.includes(c.name.toLowerCase()));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] panel auto -> #' + f.name); return f; }
    }
    for (const g of client.guilds.cache.values()) {
      const me = g.members.me;
      const f = g.channels.cache.find((c) => c.type === ChannelType.GuildText && me &&
        c.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] panel auto -> #' + f.name); return f; }
    }
    return null;
  }

  async function ensurePanel(force = false) {
    const ch = await resolveChannel(force);
    if (!ch) { console.warn('[bot] sin canal de panel'); return null; }
    const me = ch.guild.members.me;
    const perms = ch.permissionsFor(me);
    const missing = [];
    if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
    if (!perms.has(PermissionFlagsBits.EmbedLinks)) missing.push('Embed Links');
    if (missing.length) console.warn('[bot] faltan permisos en #' + ch.name + ': ' + missing.join(', '));

    state.panel = ch.id;
    const mid = store.metaGet('panelMessageId');
    if (mid && !force) {
      const m = await ch.messages.fetch(mid).catch(() => null);
      if (m) { await m.edit({ embeds: [panelEmbed(store)] }).catch(() => {}); return m; }
    }
    const m = await ch.send({ embeds: [panelEmbed(store)] })
      .catch((e) => { console.error('[bot] panel send:', e.message); return null; });
    if (m) { store.metaSet('panelMessageId', m.id); m.pin().catch(() => {}); }
    return m;
  }

  async function notifyNew(u) {
    if (!state.online) { console.warn('[bot] offline -> solicitud ' + u.hwid + ' no notificada'); return; }
    const ch = await resolveChannel();
    if (!ch) { console.error('[bot] sin canal -> ' + u.hwid + ' sin notificar'); return; }
    await ch.send({
      content: OWNER ? `<@${OWNER}> nueva solicitud` : 'Nueva solicitud',
      embeds: [userEmbed(u, false)],
      components: [userButtons(u.hwid, false)]
    }).catch((e) => console.error('[bot] notify:', e.message));
  }

  /* ---------- registro de comandos ---------- */
  async function registerIn(guild) {
    try {
      await guild.commands.set(COMMANDS.map((c) => c.toJSON()));
      console.log('[bot] comandos OK en "' + guild.name + '"');
    } catch (e) {
      if (e.code === 50001 || e.status === 403) {
        console.error('[bot] NO puedo registrar comandos en "' + guild.name + '": falta el scope applications.commands. ' +
          'Reinvita el bot con scopes bot + applications.commands.');
      } else {
        console.error('[bot] registrar en "' + guild.name + '": ' + e.message);
      }
    }
  }
  const registerAll = async () => { for (const g of client.guilds.cache.values()) await registerIn(g); };

  /* ---------- handlers ---------- */
  function attach(c) {
    c.on(Events.Error, (e) => { state.lastError = e.message; console.error('[bot] client error:', e.message); });
    c.on(Events.Warn, (m) => console.warn('[bot] warn:', m));
    c.on(Events.ShardDisconnect, (e, id) => console.warn('[bot] shard ' + id + ' desconectado (code ' + e.code + ')'));
    c.on(Events.ShardError, (e, id) => { state.lastError = e.message; console.error('[bot] shard ' + id + ' error:', e.message); });
    c.on(Events.Invalidated, () => { console.error('[bot] SESION INVALIDADA -> reinicia el servicio'); state.online = false; });
    if (String(process.env.DEBUG_GATEWAY || 'false') === 'true') c.on(Events.Debug, (m) => console.log('[gw] ' + m));

    c.once(Events.ClientReady, async (me) => {
      state.online = true; state.tag = me.user.tag; state.id = me.user.id; state.guilds = c.guilds.cache.size;
      console.log('[bot] ONLINE como ' + me.user.tag + ' (' + me.user.id + ') en ' + state.guilds + ' guild(s)');
      console.log('[bot] intents: ' + state.intents);
      if (state.guilds === 0) console.warn('[bot] el bot no esta en ningun server -> invitalo');
      await registerAll();
      await ensurePanel();
      if (OWNER) {
        const u = await c.users.fetch(OWNER).catch(() => null);
        if (u) console.log('[bot] owner OK: ' + u.tag);
        else console.warn('[bot] OWNER_ID ' + OWNER + ' no se pudo resolver (¿id correcto?)');
      } else console.warn('[bot] OWNER_ID vacio -> staff = quien tenga Manage Server');
    });

    c.on(Events.GuildCreate, async (g) => {
      console.log('[bot] invitado a "' + g.name + '"');
      await registerIn(g);
      if (!store.metaGet('panelChannelId')) await ensurePanel(true);
    });

    /* autocomplete */
    c.on(Events.InteractionCreate, async (i) => {
      if (!i.isAutocomplete()) return;
      try {
        const q = String(i.options.getFocused() || '').toUpperCase();
        const pool = ['accept', 'deny', 'reset', 'black'].includes(i.commandName)
          ? store.list().filter((u) => u.status !== 'approved')
          : store.list();
        await i.respond(pool
          .filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q))
          .slice(0, 25)
          .map((u) => ({ name: `${short(u.hwid)}… · ${clean(u.name)} · ${u.status}`, value: u.hwid })));
      } catch (e) { console.error('[bot] autocomplete:', e.message); }
    });

    /* botones */
    c.on(Events.InteractionCreate, async (i) => {
      if (!i.isButton()) return;
      try {
        if (!isStaff(i.member || { id: i.user.id, permissions: null })) {
          return i.reply({ content: 'Solo el owner puede decidir.', ephemeral: true });
        }
        const [act, hwid] = i.customId.split(':');
        if (!store.get(hwid)) return i.reply({ content: 'Ese HWID ya no existe.', ephemeral: true });
        const map = { acc: 'approved', den: 'denied', blk: 'blacklist' };
        store.set(hwid, { status: map[act], decidedAt: Date.now(), decidedBy: i.user.tag });
        await i.update({ embeds: [userEmbed(store.get(hwid), true)], components: [userButtons(hwid, true)] }).catch(() => {});
        await ensurePanel();
      } catch (e) { console.error('[bot] button:', e.message); }
    });

    /* slash */
    c.on(Events.InteractionCreate, async (i) => {
      if (!i.isChatInputCommand()) return;
      try {
        const staff = isStaff(i.member || { id: i.user.id, permissions: null });
        const say = (p) => i.reply(typeof p === 'string' ? { content: p, ephemeral: true } : { ...p, ephemeral: true });
        const hwid = String(i.options.getString('hwid') || '').toUpperCase();

        if (i.commandName === 'help') {
          return say([
            '**Hook Slx Auth**',
            '`/panel` `/setup #canal` `/sync` `/diag` `/stats`',
            '`/pending` `/users` `/active` `/blacklist` `/find`',
            '`/accept` `/deny` `/reset` `/black` `/unblack` `/remove`'
          ].join('\n'));
        }
        if (i.commandName === 'diag') {
          const ch = await resolveChannel();
          const me = i.guild ? i.guild.members.me : null;
          const perms = (ch && me) ? ch.permissionsFor(me) : null;
          return say({
            embeds: [new EmbedBuilder().setTitle('Diagnostico')
              .addFields(
                { name: 'Bot', value: `${state.tag} (\`${state.id}\`)`, inline: true },
                { name: 'Online', value: String(state.online), inline: true },
                { name: 'Guilds', value: String(state.guilds), inline: true },
                { name: 'Intents', value: state.intents, inline: true },
                { name: 'Panel', value: ch ? '<#' + ch.id + '>' : 'no resuelto', inline: true },
                { name: 'Perms canal', value: perms ? (perms.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]) ? 'OK' : 'FALTAN') : '-', inline: true },
                { name: 'Ultimo error', value: state.lastError ? String(state.lastError).slice(0, 120) : 'ninguno' }
              ).setColor(0x3ea6ff).setTimestamp(new Date())]
          });
        }
        if (!staff) return say('Solo el owner.');

        switch (i.commandName) {
          case 'panel': {
            const ch = await resolveChannel();
            if (!ch) return say('Sin canal. Usa `/setup`.');
            await ch.send({ embeds: [panelEmbed(store)] });
            return say('Panel enviado en <#' + ch.id + '>.');
          }
          case 'setup': {
            const ch = i.options.getChannel('canal') || i.channel;
            if (!ch || !ch.isTextBased()) return say('Canal invalido.');
            store.metaSet('panelChannelId', ch.id); store.metaDel('panelMessageId');
            await ensurePanel(true);
            return say('Canal del panel: <#' + ch.id + '>.');
          }
          case 'sync': await ensurePanel(true); return say('Panel recreado.');
          case 'stats': {
            const c2 = (s) => store.count(s);
            return say({ embeds: [new EmbedBuilder().setTitle('Estadisticas')
              .setDescription(`Total **${store.list().length}** · Aprobados **${c2('approved')}** · Pendientes **${c2('pending')}** · Denegados **${c2('denied')}** · Blacklist **${c2('blacklist')}**`)
              .setColor(0x3ea6ff)] });
          }
          case 'pending': {
            const l = store.list().filter((u) => u.status === 'pending');
            return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)}`).join('\n') : 'Nada pendiente.');
          }
          case 'users': {
            const l = store.list().slice(0, 40);
            return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${u.status}`).join('\n') : 'Vacio.');
          }
          case 'active': {
            const l = store.list().filter((u) => u.status === 'approved');
            return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)}`).join('\n') : 'Vacio.');
          }
          case 'blacklist': {
            const l = store.list().filter((u) => u.status === 'blacklist');
            return say(l.length ? l.map((u) => `\`${u.hwid}\``).join('\n') : 'Vacio.');
          }
          case 'find': {
            const q = String(i.options.getString('texto') || '').toUpperCase();
            const l = store.list().filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q)).slice(0, 30);
            return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)} · ${u.status}`).join('\n') : 'Nada.');
          }
          case 'accept': case 'deny': case 'reset': case 'black': case 'unblack': case 'remove': {
            if (!HWID_RE.test(hwid)) return say('HWID invalido: ' + (hwid || '(vacio)'));
            if (!store.get(hwid) && i.commandName !== 'black') return say('No existe: ' + hwid);
            const now = Date.now();
            if (i.commandName === 'accept')  { store.set(hwid, { status: 'approved', decidedAt: now, decidedBy: i.user.tag }); return say('Aprobado: ' + hwid); }
            if (i.commandName === 'deny')    { store.set(hwid, { status: 'denied', decidedAt: now, decidedBy: i.user.tag }); return say('Denegado: ' + hwid); }
            if (i.commandName === 'reset')   { store.set(hwid, { status: 'pending', decidedAt: null }); return say('A pendiente: ' + hwid); }
            if (i.commandName === 'black')   { store.set(hwid, { status: 'blacklist', decidedAt: now, decidedBy: i.user.tag }); return say('Blacklist: ' + hwid); }
            if (i.commandName === 'unblack') { store.set(hwid, { status: 'pending', decidedAt: null }); return say('Fuera de blacklist: ' + hwid); }
            if (i.commandName === 'remove')  { store.remove(hwid); return say('Borrado: ' + hwid); }
            return;
          }
        }
      } catch (e) {
        console.error('[bot] command:', e.message);
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
    try {
      await client.login(TOKEN);
    } catch (e) {
      state.lastError = e.message;
      const disallowed = /disallowed intents/i.test(e.message);
      if (disallowed && wantMsgContent) {
        console.warn('[bot] intents privilegiados no habilitados en el portal -> reconecto solo con Guilds');
        try { client.destroy(); } catch {}
        wantMsgContent = false;
        client = build(false);
        await client.login(TOKEN);
      } else if (disallowed) {
        console.error('[bot] Used disallowed intents: activa los intents en el Developer Portal o quita MessageContent');
        throw e;
      } else {
        throw e;
      }
    }
  }

  /* ---------- login con reintentos ---------- */
  let tries = 0;
  async function boot() {
    try { await connect(); }
    catch (e) {
      state.lastError = e.message;
      tries++;
      const wait = Math.min(60000, 4000 * tries);
      if (tries <= 10) {
        console.error('[bot] login fallo (' + tries + '/10): ' + e.message + ' -> reintento en ' + (wait / 1000) + 's');
        setTimeout(boot, wait);
      } else {
        console.error('[bot] login abandonado. Corre `npm run diagnose` para ver la causa exacta.');
      }
    }
  }
  boot();

  return Promise.resolve({
    notifyNew,
    status: () => state,
    isOnline: () => state.online,
    guilds: () => state.guilds,
    client: () => client
  });
}

module.exports = { startBot, sanitizeToken, tokenBotId };