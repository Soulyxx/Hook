'use strict';
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');

const esc = (s) => String(s || '-').replace(/`/g, '\u200b`').slice(0, 60);

function startBot(store) {
  const TOKEN = process.env.DISCORD_TOKEN;
  const OWNER = process.env.OWNER_ID;
  const CHAN  = process.env.PANEL_CHANNEL_ID;
  if (!TOKEN || !OWNER || !CHAN) {
    console.warn('[bot] faltan DISCORD_TOKEN / OWNER_ID / PANEL_CHANNEL_ID');
    return Promise.resolve(null);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel]
  });

  const isOwner = (id) => id === OWNER;
  const channel = () => client.channels.fetch(CHAN).catch(() => null);

  const embedFor = (u) => new EmbedBuilder()
    .setTitle('Hook Slx — Access Request')
    .addFields(
      { name: 'HWID', value: '`' + u.hwid + '`' },
      { name: 'User', value: esc(u.name), inline: true },
      { name: 'Version', value: esc(u.version), inline: true },
      { name: 'Status', value: String(u.status), inline: true }
    )
    .setColor(u.status === 'approved' ? 0x4ade80 : (u.status === 'denied' || u.status === 'blacklist') ? 0xf87171 : 0xfacc15)
    .setFooter({ text: 'Hook Slx Auth' })
    .setTimestamp(new Date());

  const row = (hwid, done) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('acc:' + hwid).setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(!!done),
    new ButtonBuilder().setCustomId('den:' + hwid).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(!!done)
  );

  async function notifyNew(u) {
    const ch = await channel();
    if (!ch) return;
    ch.send({ content: `<@${OWNER}> nueva solicitud`, embeds: [embedFor(u)], components: [row(u.hwid)] })
      .catch((e) => console.error('[bot] post', e.message));
  }

  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isButton()) return;
    if (!isOwner(i.user.id)) return i.reply({ content: 'Solo el owner.', ephemeral: true });
    const [act, hwid] = i.customId.split(':');
    if (!store.get(hwid)) return i.reply({ content: 'No existe.', ephemeral: true });
    store.set(hwid, {
      status: act === 'acc' ? 'approved' : 'denied',
      decidedAt: Date.now(),
      decidedBy: i.user.tag
    });
    await i.update({ embeds: [embedFor(store.get(hwid))], components: [row(hwid, true)] }).catch(() => {});
  });

  client.on(Events.MessageCreate, async (m) => {
    if (m.author.bot || !m.content.startsWith('!')) return;
    if (!isOwner(m.author.id) && m.channelId !== CHAN) return;
    const [cmd, ...args] = m.content.trim().slice(1).split(/\s+/);
    const arg = (args[0] || '').toUpperCase();
    const say = (t) => m.reply(t).catch(() => {});

    switch (cmd) {
      case 'panel': {
        const ch = await channel(); if (!ch) return say('Canal no encontrado.');
        const u = store.list();
        const c = (s) => u.filter((x) => x.status === s).length;
        return ch.send({ embeds: [new EmbedBuilder()
          .setTitle('Hook Slx — Auth Panel')
          .setDescription(`Total: **${u.length}**\nAprobados: **${c('approved')}**\nPendientes: **${c('pending')}**\nBlacklist: **${c('blacklist')}**`)
          .setColor(0x60a5fa).setTimestamp(new Date())] });
      }
      case 'pending': { const l = store.list().filter((x) => x.status === 'pending');
        return say(l.length ? l.map((x) => `\`${x.hwid}\` — ${esc(x.name)}`).join('\n') : 'Nada pendiente.'); }
      case 'users': { const l = store.list();
        return say(l.length ? l.slice(0, 40).map((x) => `\`${x.hwid}\` ${x.status}`).join('\n') : 'Vacio.'); }
      case 'active': { const l = store.list().filter((x) => x.status === 'approved');
        return say(l.length ? l.map((x) => `\`${x.hwid}\` ${esc(x.name)}`).join('\n') : 'Vacio.'); }
      case 'blacklist': { const l = store.list().filter((x) => x.status === 'blacklist');
        return say(l.length ? l.map((x) => `\`${x.hwid}\``).join('\n') : 'Vacio.'); }
      case 'find': {
        const q = args.join(' ').toUpperCase();
        const l = store.list().filter((x) => x.hwid.includes(q) || String(x.name || '').toUpperCase().includes(q));
        return say(l.length ? l.map((x) => `\`${x.hwid}\` ${esc(x.name)} ${x.status}`).join('\n') : 'Nada.');
      }
      case 'accept': case 'deny': case 'remove': case 'black': case 'unblack': {
        if (!arg) return say('Uso: !' + cmd + ' <HWID>');
        if (!store.get(arg) && cmd !== 'black') return say('No existe: ' + arg);
        if (cmd === 'accept') store.set(arg, { status: 'approved' });
        if (cmd === 'deny') store.set(arg, { status: 'denied' });
        if (cmd === 'remove') store.remove(arg);
        if (cmd === 'black') store.set(arg, { status: 'blacklist' });
        if (cmd === 'unblack') store.set(arg, { status: 'pending' });
        return say('OK: ' + cmd + ' ' + arg);
      }
      default: return;
    }
  });

  client.once(Events.ClientReady, (c) => console.log('[bot] logueado como ' + c.user.tag));
  return client.login(TOKEN).then(() => ({ notifyNew }));
}

module.exports = { startBot };