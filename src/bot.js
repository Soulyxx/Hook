'use strict';
const {
  Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, SlashCommandBuilder, ChannelType, PermissionFlagsBits
} = require('discord.js');

const HWID_RE = /^[A-Z0-9]{8,64}$/;
const clean = (s) => String(s || '-').replace(/`/g, "'").slice(0, 60);
const short = (h) => h.slice(0, 8);

/* ================= SLASH COMMANDS ================= */
const hwidOption = (o) => o
  .setName('hwid').setDescription('HWID del usuario').setRequired(true)
  .setAutocomplete(true);

const COMMANDS = [
  new SlashCommandBuilder().setName('panel').setDescription('Muestra el panel de control'),
  new SlashCommandBuilder().setName('setup')
    .setDescription('Define el canal del panel')
    .addChannelOption((o) => o.setName('canal').setDescription('Canal de texto').addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder().setName('pending').setDescription('Lista las solicitudes pendientes'),
  new SlashCommandBuilder().setName('users').setDescription('Lista todos los usuarios'),
  new SlashCommandBuilder().setName('active').setDescription('Lista los usuarios aprobados'),
  new SlashCommandBuilder().setName('blacklist').setDescription('Lista la blacklist'),
  new SlashCommandBuilder().setName('stats').setDescription('Estadisticas'),
  new SlashCommandBuilder().setName('find')
    .setDescription('Busca por HWID o nombre')
    .addStringOption((o) => o.setName('texto').setDescription('Texto a buscar').setRequired(true)),
  new SlashCommandBuilder().setName('accept').setDescription('Aprueba un HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('deny').setDescription('Deniega un HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('reset').setDescription('Vuelve un HWID a pendiente').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('black').setDescription('Manda un HWID a la blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('unblack').setDescription('Saca un HWID de la blacklist').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('remove').setDescription('Borra un HWID').addStringOption(hwidOption),
  new SlashCommandBuilder().setName('sync').setDescription('Recrea el mensaje del panel'),
  new SlashCommandBuilder().setName('test').setDescription('Envia un embed de prueba'),
  new SlashCommandBuilder().setName('help').setDescription('Ayuda')
];

/* ================= HELPERS ================= */
function panelEmbed(store) {
  const u = store.list();
  const c = (s) => u.filter((x) => x.status === s).length;
  return new EmbedBuilder()
    .setTitle('Hook Slx — Access Panel')
    .setDescription([
      '**Estado del sistema**',
      `Total: **${u.length}**`,
      `Aprobados: **${c('approved')}**`,
      `Pendientes: **${c('pending')}**`,
      `Denegados: **${c('denied')}**`,
      `Blacklist: **${c('blacklist')}**`,
      '',
      'Usa los botones del mensaje de solicitud, o los comandos `/accept`, `/deny`, `/black`.'
    ].join('\n'))
    .setColor(0x3ea6ff)
    .setFooter({ text: 'Hook Slx Auth • panel' })
    .setTimestamp(new Date());
}

function userEmbed(u, done) {
  const color = u.status === 'approved' ? 0x22c26e
    : (u.status === 'denied' || u.status === 'blacklist') ? 0xff4d5e
    : 0xf0a72c;
  return new EmbedBuilder()
    .setTitle(done ? 'Hook Slx — Access Request (decidido)' : 'Hook Slx — Access Request')
    .addFields(
      { name: 'HWID', value: '`' + u.hwid + '`' },
      { name: 'Usuario', value: clean(u.name), inline: true },
      { name: 'Version', value: clean(u.version), inline: true },
      { name: 'Estado', value: String(u.status || 'pending'), inline: true }
    )
    .setColor(color)
    .setFooter({ text: done ? 'decidido por ' + (u.decidedBy || '-') : 'Hook Slx Auth' })
    .setTimestamp(new Date(u.decidedAt || u.created || Date.now()));
}

function userButtons(hwid, done) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc:' + hwid).setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId('den:' + hwid).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done),
    new ButtonBuilder().setCustomId('blk:' + hwid).setLabel('Blacklist').setStyle(ButtonStyle.Secondary).setDisabled(!!done)
  );
}

/* ================= BOT ================= */
function startBot(store) {
  const TOKEN  = process.env.DISCORD_TOKEN;
  const OWNER  = process.env.OWNER_ID;
  const ADMINS = String(process.env.ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);

  if (!TOKEN) {
    console.warn('[bot] DISCORD_TOKEN ausente -> bot desactivado (la app usara /api/hello igual)');
    return Promise.resolve(null);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  const isStaff = (id) => !OWNER || id === OWNER || ADMINS.includes(id);
  const ready = new Promise((res) => client.once(Events.ClientReady, res));

  /* ---------- canal del panel: env -> guardado -> buscar por nombre -> primero usable ---------- */
  async function resolveChannel(force = false) {
    if (!force) {
      const cached = store.metaGet('panelChannelId');
      if (cached) {
        const ch = await client.channels.fetch(cached).catch(() => null);
        if (ch && ch.isTextBased()) return ch;
      }
    }
    const envId = process.env.PANEL_CHANNEL_ID;
    if (envId) {
      const ch = await client.channels.fetch(envId).catch(() => null);
      if (ch && ch.isTextBased()) { store.metaSet('panelChannelId', ch.id); return ch; }
      console.warn('[bot] PANEL_CHANNEL_ID invalido: ' + envId);
    }
    const names = ['hook-slx', 'hookslx', 'hook-slx-panel', 'panel', 'auth', 'accesos', 'accesos-hook'];
    for (const g of client.guilds.cache.values()) {
      const f = g.channels.cache.find((c) => c.isTextBased() && names.includes(c.name.toLowerCase()));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] panel auto -> #' + f.name); return f; }
    }
    for (const g of client.guilds.cache.values()) {
      const me = g.members.me;
      const f = g.channels.cache.find((c) =>
        c.type === ChannelType.GuildText && me &&
        c.permissionsFor(me).has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]));
      if (f) { store.metaSet('panelChannelId', f.id); console.log('[bot] panel auto -> #' + f.name); return f; }
    }
    return null;
  }

  async function ensurePanel(force = false) {
    const ch = await resolveChannel(force);
    if (!ch) { console.warn('[bot] no encontre canal para el panel'); return null; }
    const mid = store.metaGet('panelMessageId');
    if (mid && !force) {
      const m = await ch.messages.fetch(mid).catch(() => null);
      if (m) { await m.edit({ embeds: [panelEmbed(store)] }).catch(() => {}); return m; }
    }
    const m = await ch.send({ embeds: [panelEmbed(store)] }).catch((e) => { console.error('[bot] panel send:', e.message); return null; });
    if (m) { store.metaSet('panelMessageId', m.id); m.pin().catch(() => {}); }
    return m;
  }

  async function notifyNew(u) {
    await ready;
    const ch = await resolveChannel();
    if (!ch) { console.error('[bot] sin canal -> no se notifico ' + u.hwid); return; }
    await ch.send({
      content: OWNER ? `<@${OWNER}> nueva solicitud` : 'nueva solicitud',
      embeds: [userEmbed(u, false)],
      components: [userButtons(u.hwid, false)]
    }).catch((e) => console.error('[bot] notify:', e.message));
  }

  /* ---------- registro automatico de comandos ---------- */
  async function registerIn(guild) {
    try {
      await guild.commands.set(COMMANDS.map((c) => c.toJSON()));
      console.log('[bot] comandos registrados en ' + guild.name);
    } catch (e) { console.error('[bot] registrar en ' + guild.name + ': ' + e.message); }
  }
  async function registerAll() {
    for (const g of client.guilds.cache.values()) await registerIn(g);
  }

  /* ---------- eventos ---------- */
  client.on(Events.Error, (e) => console.error('[bot] client error:', e.message));
  client.on(Events.Warn, (m) => console.warn('[bot] warn:', m));

  client.once(Events.ClientReady, async (c) => {
    console.log('[bot] ONLINE como ' + c.user.tag + ' en ' + c.guilds.cache.size + ' guild(s)');
    await registerAll();
    await ensurePanel();
    const ch = await resolveChannel();
    if (!ch) {
      console.warn('[bot] AVISO: no hay canal de panel. Usa /setup o crea un canal #hook-slx y reinicia.');
    } else {
      console.log('[bot] panel listo en #' + ch.name);
    }
  });

  client.on(Events.GuildCreate, async (g) => { await registerIn(g); if (!store.metaGet('panelChannelId')) await ensurePanel(true); });

  /* ---------- autocompletado ---------- */
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isAutocomplete()) return;
    try {
      const q = i.options.getFocused().toUpperCase();
      const all = store.list();
      const pool = ['accept', 'deny', 'reset', 'black'].includes(i.commandName)
        ? all.filter((u) => u.status === 'pending' || u.status === 'denied')
        : all;
      const list = pool
        .filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q))
        .slice(0, 25)
        .map((u) => ({ name: `${short(u.hwid)}… · ${clean(u.name)} · ${u.status}`, value: u.hwid }));
      await i.respond(list);
    } catch (e) { console.error('[bot] autocomplete:', e.message); }
  });

  /* ---------- botones ---------- */
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isButton()) return;
    try {
      if (!isStaff(i.user.id)) return i.reply({ content: 'Solo el owner puede decidir.', ephemeral: true });
      const [act, hwid] = i.customId.split(':');
      const u = store.get(hwid);
      if (!u) return i.reply({ content: 'Ese HWID ya no existe.', ephemeral: true });

      if (act === 'acc') store.set(hwid, { status: 'approved', decidedAt: Date.now(), decidedBy: i.user.tag });
      if (act === 'den') store.set(hwid, { status: 'denied', decidedAt: Date.now(), decidedBy: i.user.tag });
      if (act === 'blk') store.set(hwid, { status: 'blacklist', decidedAt: Date.now(), decidedBy: i.user.tag });

      const upd = store.get(hwid);
      await i.update({ embeds: [userEmbed(upd, true)], components: [userButtons(hwid, true)] }).catch(() => {});
      await ensurePanel();
    } catch (e) { console.error('[bot] button:', e.message); }
  });

  /* ---------- slash commands ---------- */
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isChatInputCommand()) return;
    try {
      if (!isStaff(i.user.id)) return i.reply({ content: 'Solo el owner.', ephemeral: true });
      const say = (payload) => i.reply(typeof payload === 'string' ? { content: payload } : payload);
      const hwid = (i.options.getString('hwid') || '').toUpperCase();

      switch (i.commandName) {
        case 'help':
          return say([
            '**Hook Slx Auth — comandos**',
            '`/panel` panel de control',
            '`/setup #canal` fija el canal del panel',
            '`/pending` solicitudes pendientes',
            '`/users` todos los usuarios',
            '`/active` aprobados',
            '`/blacklist` blacklist',
            '`/find <texto>` buscar',
            '`/accept <hwid>` · `/deny <hwid>` · `/reset <hwid>`',
            '`/black <hwid>` · `/unblack <hwid>` · `/remove <hwid>`',
            '`/stats` · `/sync` · `/test`'
          ].join('\n'));

        case 'panel': {
          const ch = await resolveChannel();
          if (!ch) return say('No hay canal de panel. Usa `/setup`.');
          await ch.send({ embeds: [panelEmbed(store)] });
          return say({ content: 'Panel enviado en <#' + ch.id + '>.', ephemeral: true });
        }

        case 'setup': {
          const ch = i.options.getChannel('canal') || i.channel;
          if (!ch || !ch.isTextBased()) return say('Canal invalido.');
          store.metaSet('panelChannelId', ch.id);
          store.metaDel('panelMessageId');
          await ensurePanel(true);
          return say({ content: 'Canal del panel fijado: <#' + ch.id + '>.', ephemeral: true });
        }

        case 'sync': { await ensurePanel(true); return say('Panel recreado.'); }

        case 'test':
          return say({ embeds: [new EmbedBuilder().setTitle('Hook Slx Auth').setDescription('El bot responde correctamente.').setColor(0x22c26e).setTimestamp(new Date())] });

        case 'stats': {
          const c = (s) => store.count(s);
          return say({
            embeds: [new EmbedBuilder().setTitle('Estadisticas')
              .setDescription(`Total **${store.list().length}** · Aprobados **${c('approved')}** · Pendientes **${c('pending')}** · Denegados **${c('denied')}** · Blacklist **${c('blacklist')}**`)
              .setColor(0x3ea6ff).setTimestamp(new Date())]
          });
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
          const q = (i.options.getString('texto') || '').toUpperCase();
          const l = store.list().filter((u) => u.hwid.includes(q) || String(u.name || '').toUpperCase().includes(q)).slice(0, 30);
          return say(l.length ? l.map((u) => `\`${u.hwid}\` · ${clean(u.name)} · ${u.status}`).join('\n') : 'Nada.');
        }

        case 'accept': case 'deny': case 'reset': case 'black': case 'unblack': case 'remove': {
          if (!hwid) return say('Pasa un HWID valido.');
          if (!HWID_RE.test(hwid)) return say('HWID invalido: ' + hwid);
          if (!store.get(hwid) && i.commandName !== 'black') return say('No existe: ' + hwid);
          if (i.commandName === 'accept')  { store.set(hwid, { status: 'approved', decidedAt: Date.now(), decidedBy: i.user.tag }); return say('Aprobado: ' + hwid); }
          if (i.commandName === 'deny')    { store.set(hwid, { status: 'denied', decidedAt: Date.now(), decidedBy: i.user.tag });   return say('Denegado: ' + hwid); }
          if (i.commandName === 'reset')   { store.set(hwid, { status: 'pending', decidedAt: null });                                return say('A pendiente: ' + hwid); }
          if (i.commandName === 'black')   { store.set(hwid, { status: 'blacklist', decidedAt: Date.now(), decidedBy: i.user.tag }); return say('Blacklist: ' + hwid); }
          if (i.commandName === 'unblack') { store.set(hwid, { status: 'pending', decidedAt: null });                                return say('Fuera de blacklist: ' + hwid); }
          if (i.commandName === 'remove')  { store.remove(hwid);                                                                     return say('Borrado: ' + hwid); }
          return;
        }

        default: return;
      }
    } catch (e) {
      console.error('[bot] command:', e.message);
      try { i.replied || i.deferred ? i.followUp({ content: 'Error: ' + e.message, ephemeral: true }) : i.reply({ content: 'Error: ' + e.message, ephemeral: true }); } catch {}
    }
  });

  /* ---------- login con reintentos ---------- */
  function loginWithRetry(tries = 0) {
    client.login(TOKEN).catch((e) => {
      console.error('[bot] login fallo: ' + e.message);
      const wait = Math.min(60000, 5000 * (tries + 1));
      if (tries < 8) { console.log('[bot] reintento en ' + (wait / 1000) + 's'); setTimeout(() => loginWithRetry(tries + 1), wait); }
      else console.error('[bot] login abandonado tras 8 intentos');
    });
  }
  loginWithRetry();

  return Promise.resolve({
    notifyNew,
    isOnline: () => client.isReady(),
    guilds: () => client.guilds.cache.size,
    client
  });
}

module.exports = { startBot };