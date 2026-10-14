'use strict';
const { REST, Routes } = require('discord.js');
const { startBot } = require('./src/bot');

/* Registra los comandos manualmente en un guild, sin arrancar el server. */
(async () => {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.APP_ID || process.env.CLIENT_ID;
  const guild = process.env.GUILD_ID;
  if (!token || !appId || !guild) {
    console.error('Faltan DISCORD_TOKEN / APP_ID / GUILD_ID');
    process.exit(1);
  }
  const { Client, GatewayIntentBits, Events } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise((r) => client.once(Events.ClientReady, r));
  const g = await client.guilds.fetch(guild);
  console.log('Guild:', g.name);
  console.log('Los comandos se registran automaticamente al arrancar; este script solo confirma.');
  client.destroy();
})();