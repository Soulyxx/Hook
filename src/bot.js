const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const store = require('./store');

const OWNER = process.env.OWNER_ID;
const PANEL_CHANNEL = process.env.PANEL_CHANNEL_ID;
const PREFIX = process.env.PREFIX || '!';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

let panelMessageId = null;

function fmt(ts) { return ts ? `<t:${Math.floor(ts / 1000)}:R>` : '-'; }

function userLine(u) {
  return `\`${u.hwid.slice(0, 8)}\` **${u.pc || '?'}** · ${u.user || '?'} · ${u.ip || '?'} · seen ${fmt(u.lastSeen)}`;
}

function panelEmbed(tab) {
  const e = new EmbedBuilder().setColor(0x2b2d31).setFooter({ text: 'Souly Auth' });
  if (tab === 'pending') {
    const list = store.pending();
    e.setTitle(`Pending requests (${list.length})`);
    e.setDescription(list.length ? list.map(userLine).join('\n').slice(0, 3900) : 'Nothing pending.');
  } else if (tab === 'approved') {
    const list = store.approved();
    e.setTitle(`Approved users (${list.length})`);
    e.setDescription(list.length ? list.map(userLine).join('\n').slice(0, 3900) : 'No users.');
  } else if (tab === 'active') {
    const list = store.active();
    e.setTitle(`Active now (${list.length})`);
    e.setDescription(list.length ? list.map(userLine).join('\n').slice(0, 3900) : 'Nobody online.');
  } else {
    const list = store.blacklist();
    e.setTitle(`Blacklist (${list.length})`);
    e.setDescription(list.length ? list.map(userLine).join('\n').slice(0, 3900) : 'Blacklist empty.');
  }
  return e;
}

function panelRows() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('panel:pending').setLabel('Pending').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('panel:approved').setLabel('Approved').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('panel:active').setLabel('Active').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('panel:blacklist').setLabel('Blacklist').setStyle(ButtonStyle.Danger)
  )];
}

async function ensurePanel() {
  const ch = await client.channels.fetch(PANEL_CHANNEL).catch(() => null);
  if (!ch) return console.warn('[bot] panel channel not found');
  const msgs = await ch.messages.fetch({ limit: 20 }).catch(() => null);
  const mine = msgs ? msgs.find((m) => m.author.id === client.user.id && m.components.length) : null;
  if (mine) {
    panelMessageId = mine.id;
    await mine.edit({ embeds: [panelEmbed('pending')], components: panelRows() }).catch(() => {});
  } else {
    const m = await ch.send({ embeds: [panelEmbed('pending')], components: panelRows() });
    panelMessageId = m.id;
  }
}

async function notifyPending(u) {
  const ch = await client.channels.fetch(PANEL_CHANNEL).catch(() => null);
  if (!ch) return;
  const e = new EmbedBuilder()
    .setColor(0xf0a72c)
    .setTitle('New access request')
    .addFields(
      { name: 'PC', value: u.pc || '?', inline: true },
      { name: 'User', value: u.user || '?', inline: true },
      { name: 'IP', value: u.ip || '?', inline: true },
      { name: 'HWID', value: '`' + u.hwid + '`' }
    )
    .setTimestamp();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`req:accept:${u.hwid}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`req:deny:${u.hwid}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
  );
  await ch.send({ content: OWNER ? `<@${OWNER}>` : '', embeds: [e], components: [row] });
}

function isOwner(id) { return !OWNER || id === OWNER; }

async function startBot() {
  client.on('interactionCreate', async (i) => {
    if (!i.isButton()) return;
    if (!isOwner(i.user.id)) return i.reply({ content: 'Not for you.', ephemeral: true });

    const [kind, a, b] = i.customId.split(':');

    if (kind === 'panel') {
      return i.update({ embeds: [panelEmbed(a)], components: panelRows() });
    }
    if (kind === 'req') {
      const u = store.setStatus(b, a === 'accept' ? 'approved' : 'denied');
      await i.update({
        embeds: [EmbedBuilder.from(i.message.embeds[0]).setColor(a === 'accept' ? 0x22c26e : 0xff4d5e)
          .setFooter({ text: a === 'accept' ? 'ACCEPTED' : 'DENIED' })],
        components: []
      });
      if (panelMessageId) {
        const ch = await client.channels.fetch(PANEL_CHANNEL).catch(() => null);
        const m = ch && await ch.messages.fetch(panelMessageId).catch(() => null);
        if (m) m.edit({ embeds: [panelEmbed('pending')], components: panelRows() }).catch(() => {});
      }
      return;
    }
  });

  client.on('messageCreate', async (m) => {
    if (m.author.bot || !m.content.startsWith(PREFIX) || !isOwner(m.author.id)) return;
    const [cmd, ...args] = m.content.slice(PREFIX.length).trim().split(/\s+/);
    const arg = args.join(' ');

    const find = () => {
      const list = store.byName(arg);
      return list.length === 1 ? list[0] : null;
    };

    if (cmd === 'panel') { await ensurePanel(); return m.reply('Panel ready.'); }
    if (cmd === 'pending') { return m.reply({ embeds: [panelEmbed('pending')] }); }
    if (cmd === 'users') { return m.reply({ embeds: [panelEmbed('approved')] }); }
    if (cmd === 'active') { return m.reply({ embeds: [panelEmbed('active')] }); }
    if (cmd === 'blacklist') { return m.reply({ embeds: [panelEmbed('blacklist')] }); }

    if (cmd === 'accept' || cmd === 'deny') {
      const u = find() || store.get(arg.toUpperCase());
      if (!u) return m.reply('Not found (be more specific).');
      store.setStatus(u.hwid, cmd === 'accept' ? 'approved' : 'denied');
      return m.reply(`${cmd === 'accept' ? 'Accepted' : 'Denied'}: **${u.pc}**`);
    }
    if (cmd === 'remove') {
      const u = find() || store.get(arg.toUpperCase());
      if (!u) return m.reply('Not found.');
      store.remove(u.hwid);
      return m.reply(`Removed: **${u.pc}** (access revoked)`);
    }
    if (cmd === 'black') {
      const u = find() || store.get(arg.toUpperCase());
      if (!u) return m.reply('Not found.');
      store.setStatus(u.hwid, 'blacklisted');
      return m.reply(`Blacklisted: **${u.pc}**`);
    }
    if (cmd === 'unblack') {
      const u = find() || store.get(arg.toUpperCase());
      if (!u) return m.reply('Not found.');
      store.setStatus(u.hwid, 'pending');
      return m.reply(`Unblacklisted: **${u.pc}** (now pending)`);
    }
    if (cmd === 'find') {
      const list = store.byName(arg);
      return m.reply(list.length ? list.map(userLine).join('\n') : 'No match.');
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
  await new Promise((r) => client.once('ready', r));
  console.log('[bot] logged in as ' + client.user.tag);
  await ensurePanel();
  return client;
}

module.exports = { startBot, notifyPending };