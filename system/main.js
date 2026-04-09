import 'dotenv/config';
import mineflayer from 'mineflayer';
import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import chalk from "chalk";
import yaml from 'js-yaml';
import sqlite3 from 'sqlite3';
export const db = new sqlite3.Database('./bot.db');
import { config, t, languages } from './loaders.js';

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    nickname TEXT UNIQUE NOT NULL,
    role TEXT DEFAULT 'user',
    balance INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS bans (
    nickname TEXT PRIMARY KEY,
    unbanAt INTEGER NOT NULL,
    reason TEXT DEFAULT '???'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS blacklist (
    nickname TEXT PRIMARY KEY
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS user_permissions (
    nickname TEXT NOT NULL,
    command TEXT NOT NULL,
    PRIMARY KEY (nickname, command)
  )
`);

import { preCommandCheck, commands } from './commands.js';
import { globals } from './globals.js';
import { pluginCommands, plugins, loadAllPlugins } from './PluginManager.js';

export const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
export let discordOutput = null;
let discordLogOutput;
const recentMessages = new Set();

export const startTime = Date.now();
let lastAiCall = 0;
const aiCooldown = config.ai.cooldown;
let currentGame = null;
let awaitingAnswer = false;
let gameTimeout = null;
const DefaultChatGameRewards = [
  { amount: 500, chance: 0.1 },
  { amount: 250, chance: 0.3 },
  { amount: 150, chance: 0.4 },
  { amount: 100, chance: 0.5 },
  { amount: 50, chance: 1.0 }
];
export let purchases = {};
export let shop = [];
const chatLogList = [];
export const seenPlayers = new Set();
let fullySpawned = false;
export let roles = {};
export let codesCache = {};
export const codesFile = './settings/codes.yml';

if (!process.env.AI_API_KEY) {
  console.error(chalk.hex('#FF0000')(t('errors.ai_api_key_missing')));
  process.exit(1);
}

export const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.botnick,
  version: config.mcversion
});

await loadAllPlugins();

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);

  try {
    await discordOutput.send({ embeds: [sendEmbed(`⚠️ Uncaught Exception`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `\`\`\`${err.stack || err.message}\`\`\``, inline: true }], timestamp: true })] });
  } catch (e) {
    console.error(chalk.hex('#FF7C7C')(e));
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[unhandledRejection]', reason);

  try {
    await discordOutput.send({ embeds: [sendEmbed(`⚠️ Unhandled Rejection`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `\`\`\`${reason.stack || reason}\`\`\``, inline: true }], timestamp: true })] });
  } catch (e) {
    console.error(chalk.hex('#FF7C7C')(e));
  }
});

discordClient.login(process.env.DISCORD_TOKEN);

discordClient.once('ready', async () => {
  console.log(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#acacac')(t('discord.bot_logged_in', { tag: discordClient.user.tag }))
  );

  const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) {
    console.warn(
      chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
      chalk.hex('#FF7C7C')(t('discord.server_notfound'))
    );
    return;
  }

  discordOutput = guild.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
  if (!discordOutput) console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')(t('discord.cmdchannel_notfound'))
  );

  discordLogOutput = guild.channels.cache.get(process.env.DISCORD_LOG_CHANNEL_ID);
  if (!discordLogOutput) console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')(t('discord.logchannel_notfound'))
  );

  await checkUpdate();

  bot.once('spawn', async () => {
    const startType = process.env.pm_id !== undefined ? 'PM2' : t('bot.usual');
    const ip = bot._client?.socket?.remoteAddress || bot.options?.host || t('bot.unspecified');
    const port = bot._client?.socket?.remotePort || bot.options?.port || t('bot.usual');
    const ipPort = `${ip}:${port}`;

    if (!discordOutput) return;

    const embed = {
      color: 0x00ff00,
      title: t('discord.bot_online'),
      fields: [
        { name: t('discord.fields.nickname'), value: `\`${bot.username}\``, inline: true },
        { name: t('discord.fields.start_type'), value: `\`${startType}\``, inline: true },
        { name: t('discord.fields.ip'), value: `\`${ipPort}\``, inline: true },
        { name: t('discord.fields.bot_prefix'), value: `\`${config.botprefix}\``, inline: true },
      ],
      timestamp: new Date()
    };

    await discordOutput.send({ embeds: [embed] });
  });
});


discordClient.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  if (msg.channel.id !== process.env.DISCORD_CHANNEL_ID) return;

  const content = msg.content.trim();
  console.log(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#acacac')(`${msg.member.displayName}:`) + ' ' +
    chalk.hex('#ffffff')(`${content}`)
  );

  if (!content.startsWith(config.botprefix)) return;

  try {
    const guildMember = await msg.guild.members.fetch(msg.author.id);
    const roles = new Set(guildMember.roles.cache.map(role => role.id));

    if (msg.author.id && !roles.has(config.discord.roleid)) {
      await discordOutput.send({ embeds: [sendEmbed(`⛔ ${t('discord.accessdenied')}`, ``, { color: 0x5499f4, footer: 'DENIED', fields: [{ name: `${t('discord.noaccess')}`, value: `\`\`\`${content}\`\`\``, inline: true }], timestamp: true })] });
      return;
    }

    await processUserCommand('SYSTEM', content, 'discord', msg.member.displayName);

  } catch (err) {
    console.error(
      chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
      chalk.hex('#FF7C7C')(`${t('discord.command_processing_error')}: ${err.stack}`)
    );
    await msg.reply(`${t('discord.msg_command_processing_error')}`);
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('db_')) return;

  try {
    if (!globals.cachedDatabaseRows || !globals.cachedDatabaseRows.length) {
      return interaction.reply({
        content: `${t('discord.dataoutdated')}`,
        ephemeral: true
      });
    }

    const [, direction, pageStr] = interaction.customId.split('_');
    let page = Number(pageStr);

    if (direction === 'next') page++;
    if (direction === 'prev') page--;

    const pageSize = 10;
    const totalPages = Math.ceil(globals.cachedDatabaseRows.length / pageSize);

    page = Math.max(0, Math.min(page, totalPages - 1));

    const embed = buildDatabaseEmbed(globals.cachedDatabaseRows, page, pageSize);
    const buttons = buildButtons(page, totalPages);

    await interaction.update({
      embeds: [embed],
      components: [buttons]
    });

  } catch (err) {
    console.error('BUTTON ERROR:', err);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `${t('discord.buttonerror')}`,
        ephemeral: true
      });
    }
  }
});

import registryOrVersion from 'prismarine-registry';
const registry = registryOrVersion('1.21.4');
const mclang = registry.language;

const legacyColors = {
  black: "#000000",
  dark_blue: "#0000AA",
  dark_green: "#00AA00",
  dark_aqua: "#00AAAA",
  dark_red: "#AA0000",
  dark_purple: "#AA00AA",
  gold: "#FFAA00",
  gray: "#AAAAAA",
  dark_gray: "#555555",
  blue: "#5555FF",
  green: "#55FF55",
  aqua: "#55FFFF",
  red: "#FF5555",
  light_purple: "#FF55FF",
  yellow: "#FFFF55",
  white: "#FFFFFF"
};

function parseColoredText(component, mclang = {}) {
  if (!component) return '';
  if (typeof component === 'string') return component;
  if (typeof component !== 'object') return String(component);

  let chalkFn = chalk;

  if (component.color) {
    const mapped = legacyColors[component.color] || component.color;
    if (mapped.startsWith('#')) chalkFn = chalkFn.hex(mapped);
  }
  if (component.bold) chalkFn = chalkFn.bold;
  if (component.italic) chalkFn = chalkFn.italic;
  if (component.underlined) chalkFn = chalkFn.underline;
  if (component.strikethrough) chalkFn = chalkFn.strikethrough;
  if (component.obfuscated) chalkFn = chalkFn.inverse;

  let result = '';
  if (component.text) result += chalkFn(component.text);
  if (component['']) result += chalkFn(component['']);

  if (component.translate) {
    const template = mclang[component.translate] || component.translate;
    let args = [];
    if (Array.isArray(component.with)) {
      args = component.with.map(w => parseColoredText(w, mclang));
    }
    let index = 0;
    const translated = template.replace(/%[0-9\$]*s/g, () => args[index++] || '');
    result += chalkFn(translated);
  }

  if (component.extra && Array.isArray(component.extra)) {
    for (const e of component.extra) {
      result += parseColoredText(e, mclang);
    }
  }

  return result;
}

export async function outputToDiscord(message) {
  if (!discordOutput) return;

  try {
    let cleanMessage = '';

    if (typeof message === 'object') {
      cleanMessage = JSON.stringify(message.json);
    } else if (typeof message === 'string') {
      cleanMessage = message;
    }

    if (!cleanMessage || !cleanMessage.trim()) return;

    const SANITIZE = /([:@~*_|>\\`])/g;
    const sanitizedText = cleanMessage.replace(SANITIZE, '$1\u200B');

    await discordOutput.send('```' + sanitizedText + '```');

  } catch (err) {
    console.error(
      chalk.bold.hex('#7CB6FF')('[Discord Output]') + ' ' +
      chalk.hex('#FF7C7C')(`${t('discord.output_error')}: ${err}`)
    );
  }
}

async function logToDiscordChatLog(message) {
  if (!discordLogOutput) return;

  try {
    if (typeof message !== 'string' || !message.trim()) return;

    const CODE_BLOCK_REGEX = /(```\n)([\s\S]*?)(\n```)/g;

    const sanitizedMessage = message.replace(CODE_BLOCK_REGEX, (_, start, inner, end) => {
      const SANITIZE = /([:@~*_|.>\\`])/g;
      const sanitizedInner = inner.replace(SANITIZE, '$1\u200B');
      return `${start}${sanitizedInner}${end}`;
    });

    await discordLogOutput.send(sanitizedMessage);

  } catch (err) {
    console.error(
      chalk.bold.hex('#7CB6FF')('[Discord ChatLog]') + ' ' +
      chalk.hex('#FF7C7C')(`${t('discord.log_error')}: ${err}`)
    );
  }
}

const pkgjson = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);

const currentVersion = pkgjson.version;

async function checkUpdate() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/exillrei/AuroraBot/releases/latest`,
      { headers: { 'User-Agent': 'AuroraBot Update Checker' } }
    );

    if (!res.ok) return;

    const data = await res.json();
    const latestVersion = data.tag_name;

    if (latestVersion !== currentVersion) {
      console.log(
        chalk.bold.hex('#2267fb')('[UPDATE]') + ' ' +
        chalk.hex('#cdddff')(`${t('update.available')} ${latestVersion}`) + ' ' +
        chalk.hex('#3870a8')(`(${t('update.yourversion')} ${currentVersion})`)
      );
      await discordOutput.send({
        embeds: [sendEmbed(
          `✨ ${t('update.newupdate')}`,
          '',
          {
            color: 0x2267fb,
            footer: 'UPDATE',
            fields: [
              { name: `${t('update.available')}`, value: `\`${latestVersion}\``, inline: true },
              { name: `${t('update.yourversion')}`, value: `\`${currentVersion}\``, inline: true }
            ],
            timestamp: true
          }
        )]
      });
    }
  } catch (err) {
    console.error(chalk.bold.hex('#2267fb')('[UPDATE]', err));
  }
}

export async function userExists(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM users WHERE nickname = ?', [username], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

export async function resolveUserArg(arg) {
  if (!arg) return null;

  const idMatch = /^:(-?\d+)$/.exec(arg);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    const row = await new Promise((res, rej) =>
      db.get('SELECT nickname FROM users WHERE id = ?', [id], (err, r) => err ? rej(err) : res(r))
    );
    return row?.nickname ?? null;
  }

  return arg;
}

export function buildDatabaseEmbed(rows, page = 0, pageSize = 10) {
  const totalUsers = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));

  page = Math.max(0, Math.min(page, totalPages - 1));

  const start = page * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  const userLines = pageRows.length
    ? pageRows.map(r =>
      `• **ID:** \`${r.id}\` | **${t('db.nickname')}:** \`${r.nickname}\` | **${t('db.role')}:** \`${r.role}\` | **${t('db.balance')}:** \`${r.balance}\``
    ).join('\n')
    : `${t('db.nodata')}`;

  return sendEmbed(
    '📦 DataBase Info',
    `${t('db.page')} **${page + 1} / ${totalPages}**`,
    {
      color: 0x5865F2,
      fields: [
        { name: `👤 ${t('db.users')}`, value: `${t('db.total')}: **${totalUsers}**`, inline: true },
        { name: `🧠 ${t('db.engine')}`, value: 'SQLite', inline: true },
        { name: `🏷 ${t('db.users')}`, value: userLines, inline: false }
      ],
      footer: 'DATABASE',
      timestamp: true
    }
  );
}

export function buildButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`db_prev_${page}`)
      .setLabel('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),

    new ButtonBuilder()
      .setCustomId(`db_next_${page}`)
      .setLabel('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
  );
}

export function sendEmbed(
  title = null,
  description = null,
  {
    color = 0x2f3136,
    fields = [],
    footer = null,
    footerIcon = null,
    author = null,
    authorIcon = null,
    authorUrl = null,
    thumbnail = null,
    image = null,
    timestamp = false,
    url = null
  } = {}
) {
  const embed = new EmbedBuilder();

  if (color) embed.setColor(color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (url) embed.setURL(url);

  if (author) {
    embed.setAuthor({
      name: author,
      iconURL: authorIcon || undefined,
      url: authorUrl || undefined
    });
  }

  if (footer) {
    embed.setFooter({
      text: footer,
      iconURL: footerIcon || undefined
    });
  }

  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);

  if (fields.length) embed.addFields(fields);

  if (timestamp) embed.setTimestamp(new Date());

  return embed;
}

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');

  const day = pad(now.getDate());
  const month = pad(now.getMonth() + 1);
  const year = now.getFullYear();
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());

  return `[${day}.${month}.${year} | ${hours}:${minutes}:${seconds}]`;
}

function logChatEntry(entry) {
  const logEntry = `${entry}`;
  chatLogList.push(logEntry);
}

function limitCharsByWords(text, maxChars = 240) {
  if (text.length <= maxChars) return text;

  let truncated = text.slice(0, maxChars);

  if (text[maxChars] && text[maxChars] !== ' ') {
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) {
      truncated = truncated.slice(0, lastSpace);
    }
  }
  return truncated.trim();
}

async function queryAI(prompt) {
  try {
    const response = await fetch(config.ai.api, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          {
            role: 'system',
            content: config.ai.content
          },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errorMsg = `${response.status} ${response.statusText}`;
      bot.chat(`/me ${t('bot.ai_unavailable')} &8(&6${errorMsg}&8)`);
      console.error('[AI]', errorMsg);
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();

    return text;

  } catch (err) {
    const errorText = (err.message || String(err)).slice(0, 80);
    bot.chat(`/me ${t('bot.ai_unavailable')} &8(&6${errorText}&8)`);
    console.error('[AI]', err);
  }
}

function loadRoles() {
  try {
    roles = yaml.load(fs.readFileSync('./settings/roles.yml', 'utf8')) || {};
  } catch (e) {
    console.error(e);
    roles = {};
  }
}

export function saveRoles() {
  fs.writeFileSync('./settings/roles.yml', yaml.dump(roles, { lineWidth: -1 }));
}

loadRoles();

fs.watchFile('./settings/roles.yml', () => {
  loadRoles();
});

export function getRoles() {
  return roles;
}

export async function isBlacklisted(username) {
  if (username === 'SYSTEM') return false;
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM blacklist WHERE nickname = ?',
      [username],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

export async function addToBlacklist(username) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO blacklist (nickname) VALUES (?)',
      [username],
      err => err ? reject(err) : resolve()
    );
  });
}

export async function removeFromBlacklist(username) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM blacklist WHERE nickname = ?',
      [username],
      err => err ? reject(err) : resolve()
    );
  });
}

export async function getBlacklist() {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT nickname FROM blacklist',
      [],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.nickname));
      }
    );
  });
}

function cleanName(name) {
  return name.replace(/§./g, '');
}

const nickMap = new Map();

function requestRealName(nick) {
  if (!nick.startsWith('~')) return;
  bot.chat(`/realname ${nick}`);
}

function resolveUsername(nickOrDisplayName) {

  for (const [realUsername, playerData] of Object.entries(bot.players)) {
    if (!playerData || !playerData.username) continue;

    const displayName = playerData.displayName?.toString();
    if (displayName === nickOrDisplayName || realUsername === nickOrDisplayName) {
      return realUsername;
    }
  }

  return nickOrDisplayName;
}

export function getRole(nickname) {
  return new Promise(resolve => {
    db.get(
      'SELECT role FROM users WHERE nickname = ?',
      [nickname],
      (err, row) => resolve(row?.role || 'user')
    );
  });
}

async function getNextId() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id FROM users WHERE id > 0 ORDER BY id', [], (err, rows) => {
      if (err) return reject(err);

      let nextId = 1;
      for (const r of rows) {
        if (r.id === nextId) nextId++;
        else break;
      }
      resolve(nextId);
    });
  });
}

async function ensureUser(nickname) {
  if (nickname === 'SYSTEM' && nickname === 'Unknown Player') return;
  const nextId = await getNextId();

  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO users (id, nickname, role, balance) VALUES (?, ?, ?, ?)',
      [nextId, nickname, 'user', 0],
      (err) => err ? reject(err) : resolve()
    );
  });
}

export async function hasPermission(username, cmd) {
  if (!username || !cmd) return false;

  if (username === 'SYSTEM') return true;

  const role = await getRole(username);
  const roleData = roles[role];
  if (roleData) {
    const cmds = roleData.cmds || [];
    if (cmds.includes(cmd)) return true;
  }

  const user = username
  cmd = cmd.toLowerCase();

  return new Promise((resolve, reject) => {
    db.get(
      `SELECT 1 FROM user_permissions WHERE nickname = ? AND command = ? LIMIT 1`,
      [user, cmd],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

function isDuplicateMessage(username, message) {
  const key = `${username}:${message}`;
  if (recentMessages.has(key)) return true;
  recentMessages.add(key);
  setTimeout(() => recentMessages.delete(key), 3000);
  return false;
}

export function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

export async function grantPermission(nickname, command) {
  if (!nickname || !command) return;

  command = command.toLowerCase();

  db.run(
    `INSERT OR IGNORE INTO user_permissions (nickname, command) VALUES (?, ?)`,
    [nickname, command],
    (err) => {
      if (err) {
        console.error(err);
      }
    }
  );
}

export async function revokePermission(nickname, command) {
  if (!nickname || !command) return;

  command = command.toLowerCase();

  db.run(
    `DELETE FROM user_permissions WHERE nickname = ? AND command = ?`,
    [nickname, command],
    (err) => {
      if (err) {
        console.error(err);
      }
    }
  );
}

export async function getUserExtraPerms(nickname) {
  const user = nickname

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT command FROM user_permissions WHERE nickname = ?`,
      [user],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows.map(r => r.command));
      }
    );
  });
}

function startChatGame() {
  try {
    const games = yaml.load(fs.readFileSync('./settings/chatgame.yml', 'utf8'));
    if (!Array.isArray(games) || games.length === 0) {
      console.log(
        chalk.bold.hex('#00ffaa')(t('bot.chatgame_prefix')) + ' ' +
        chalk.hex('#ff7c7c')(t('bot.chatgame_noquestions'))
      );
      return;
    }

    const game = games[Math.floor(Math.random() * games.length)];
    game.rewards = DefaultChatGameRewards;

    currentGame = game;
    awaitingAnswer = true;

    bot.chat(`/me &8[&#FF0000❓&8] ${t('bot.chatgame_question')} &b${game.question}`);

    clearTimeout(gameTimeout);
    gameTimeout = setTimeout(() => {
      if (awaitingAnswer) {
        awaitingAnswer = false;
        currentGame = null;
        bot.chat(`/me &8[&#FF0000❓&8] ${t('bot.chatgame_timeup')}`);
      }
    }, 30 * 1000);
  } catch (err) {
    console.error(
      chalk.bold.hex('#00ffaa')(t('bot.chatgame_prefix')) + ' ' +
      chalk.hex('#ff7c7c')(`${t('bot.chatgame_readerror')} ${err}`)
    );
  }
}

setInterval(() => {
  if (!awaitingAnswer && bot.player) {
    startChatGame();
  }
}, 90 * 1000);

function pickReward(rewards) {
  const rand = Math.random();
  let cumulative = 0;

  for (const r of rewards) {
    cumulative += r.chance;
    if (rand <= cumulative) {
      return r.amount;
    }
  }

  return null;
}

async function giveGameReward(username) {
  awaitingAnswer = false;
  const reward = pickReward(currentGame.rewards);
  if (reward) {
    if (await isBlacklisted(username)) return bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswererror')}`);
    changeBalance(username, reward);
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswer')} &6${reward}⛃!`);
  } else {
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswererror')}`);
  }
  currentGame = null;
}

async function processAI(realNick, msgText) {

  if (await checkBan(realNick)) return;

  if (config.killswitch) return;

  if (await isBlacklisted(realNick)) {
    await bot.chat(`/m ${realNick} ${t('bot.blacklisted')}`);
    return;
  }

  const now = Date.now();
  if (now - lastAiCall < aiCooldown) {
    await bot.chat(`/m ${realNick} &c${t('bot.ai_cooldown')}`);
    return;
  }
  lastAiCall = now;

  const parts = msgText.toLowerCase().split(config.ai.text);
  if (parts.length < 2) return;

  const prompt = parts[1].trim();
  if (!prompt) return;

  await bot.chat(`/m ${realNick} ${t('bot.ai_think')}`);
  const reply = await queryAI(prompt);
  await sendLongMessage(realNick, reply);
}

async function handleChat(usernameRaw, msgText, parsed, jsonMsg, source) {
  try {
    const username = cleanName(usernameRaw);
    const timestamp = getFormattedTimestamp();

    if (isDuplicateMessage(username, msgText)) return;

    const chatRegex1 = new RegExp(config.chat.chatRegex1.pattern, config.chat.chatRegex1.flags);
    const chatRegex2 = new RegExp(config.chat.chatRegex2.pattern, config.chat.chatRegex2.flags);

    if (chatRegex1.test(parsed) && msgText.toLowerCase().includes(config.ai.text)) {

      if (usernameRaw.startsWith('~')) {
        const displayNick = usernameRaw

        if (!pendingRealnames.has(displayNick))
          pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [], aimsg: [] });

        pendingRealnames.get(displayNick).aimsg.push(msgText);

        requestRealName(usernameRaw);
        return;
      }

      if (source === 'mc') await processAI(usernameRaw, msgText);
      return;
    }

    const arrowSymbol = config.chat.arrowSymbol;
    const arrowIndex = parsed.lastIndexOf(arrowSymbol);

    if (awaitingAnswer && currentGame && arrowIndex !== -1) {
      const leftPart = parsed.slice(0, arrowIndex).trim();
      const answerText = parsed.slice(arrowIndex + 1).trim();
      let usernameRaw = leftPart.split(/\s+/).pop();

      if (usernameRaw.startsWith('~')) {
        const displayNick = usernameRaw
        if (nickMap.has(displayNick)) {
          usernameRaw = nickMap.get(displayNick);
        } else {
          if (!pendingRealnames.has(displayNick))
            pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [], aimsg: [] });
          pendingRealnames.get(displayNick).answers.push(answerText);
          requestRealName(usernameRaw);
          return;
        }
      }

      if (answerText.toLowerCase() === currentGame.answer.toLowerCase()) {
        giveGameReward(usernameRaw);
        return;
      }
    }

    const ChatMessage =
      config.chat.chatFilters.includes.some(f => parsed.includes(f)) ||
      config.chat.chatFilters.startsWith.some(f => parsed.startsWith(f));

    if (ChatMessage) {

      chatLogList.push(parsed);

      if (parsed.startsWith('『КОНСОЛЬ』')) {
        const parts = parsed.split('использовал команду');
        const leftPart = parts[0].replace('『КОНСОЛЬ』', '').trim();
        const username = leftPart.split(/\s+/).pop();
        const command = parts[1]?.trim() || '';
        const ignoredCommands = [
          '/d', '/disguise', '/undisguise', '/dis',
          '/uc', '/free', '/menu', '/donate', '/warp', '/rtp'
        ];

        if (ignoredCommands.some(c => command.toLowerCase().startsWith(c))) return;

        logToDiscordChatLog(`${timestamp} ⌨️ **\`${username}\`**\n\`\`\`\n${command}\n\`\`\``);
        return;
      }

      if (parsed.includes(arrowSymbol) && !chatRegex2.test(parsed)) {
        await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.suspiciousactivity')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.suspiciousactivity_verify')}`, value: `\`\`\`${parsed}\`\`\``, inline: true }], timestamp: true })] });
        return;
      }

      if (chatRegex1.test(parsed)) {
        const leftPart = parsed.slice(0, arrowIndex).trim();
        let usernameRaw = leftPart.split(/\s+/).pop();
        if (arrowIndex !== -1) {
          if (usernameRaw.startsWith('~')) {
            const displayNick = usernameRaw
            if (nickMap.has(displayNick)) {
              usernameRaw = nickMap.get(displayNick);
            } else {
              if (!pendingRealnames.has(displayNick))
                pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [], aimsg: [] });
              pendingRealnames.get(displayNick).logs.push({ timestamp, msgText });
              pendingRealnames.get(displayNick).commands.push(msgText);
              requestRealName(usernameRaw);
              return;
            }
          }

          try {
            await processUserCommand(usernameRaw, msgText, 'mc', null, parsed);
          } catch (err) {
            console.error(
              chalk.bold.hex('#FF0000')(t('bot.error_prefix')) + ' ' +
              chalk.hex('#ff8282')('processUserCommand:', err)
            );
          }
        }
        await logToDiscordChatLog(`${timestamp} 💬 **\`${usernameRaw}\`**\n\`\`\`\n${msgText}\n\`\`\``);
        return;
      }

      await logToDiscordChatLog(`${timestamp}\n\`\`\`\n${parsed}\n\`\`\``);
    }

    if (source === 'mc') await processUserCommand(usernameRaw, msgText, 'mc', null, parsed);

  } catch (err) {
    console.error(chalk.hex('#FF7C7C')(`${t('bot.error_prefix')}: ${err}`));
  }
}

async function sendLongMessage(realUsername, text) {
  const resolvedUsername = resolveUsername(realUsername);
  const originalCasedUsername = resolvedUsername;
  const maxLen = 240;
  let remaining = text;

  while (remaining.length > 0) {
    const chunk = limitCharsByWords(remaining, maxLen);
    await bot.chat(`/m ${originalCasedUsername} &6${chunk}`);
    remaining = remaining.slice(chunk.length).trim();
    await new Promise(r => setTimeout(r, 3000));
  }
}

export async function banUser(username, durationMs, reason) {
  const unbanAt = Date.now() + durationMs;
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO bans (nickname, unbanAt, reason) VALUES (?, ?, ?)`,
      [username, unbanAt, reason],
      err => err ? reject(err) : resolve()
    );
  });
}

export async function unbanUser(username) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM bans WHERE nickname = ?', [username], err => err ? reject(err) : resolve());
  });
}

export async function isBanned(username) {
  if (username === 'SYSTEM') return false;
  return new Promise((resolve, reject) => {
    db.get('SELECT unbanAt, reason FROM bans WHERE nickname = ?', [username], async (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(false);

      if (Date.now() > row.unbanAt) {
        await unbanUser(username);
        return resolve(false);
      }

      resolve({ unbanAt: row.unbanAt, reason: row.reason });
    });
  });
}

export async function checkBan(username) {
  if (username === 'SYSTEM') return false;
  const banInfo = await isBanned(username);
  if (banInfo) {
    const msLeft = banInfo.unbanAt - Date.now();
    const timeLeft = formatDuration(msLeft);
    bot.chat(`/m ${username} ${t('bot.bot_blocked', { timeLeft: timeLeft, reason: banInfo.reason })}`);
    return true;
  }
  return false;
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);

  return parts.join(' ');
}

export async function getBalance(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT balance FROM users WHERE nickname = ?', [username], (err, row) => {
      if (err) return reject(err);

      if (!row) {
        db.run('INSERT OR IGNORE INTO users (nickname, role, balance) VALUES (?, ?, ?)', [username, 'user', 0], (err2) => {
          if (err2) return reject(err2);
          resolve(0);
        });
      } else {
        resolve(row.balance);
      }
    });
  });
}

export async function changeBalance(username, amount) {
  const current = await getBalance(username);
  const newBalance = Math.max(0, current + amount);
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET balance = ? WHERE nickname = ?',
      [newBalance, username],
      (err) => {
        if (err) return reject(err);
        resolve(newBalance);
      }
    );
  });
}

export async function setBalance(username, amount) {
  const newBalance = Math.max(0, amount);

  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE users SET balance = ? WHERE nickname = ?',
      [newBalance, username],
      (err) => {
        if (err) return reject(err);
        resolve(newBalance);
      }
    );
  });
}

export function getBotBalance() {
  return new Promise((resolve) => {
    const listener = async (jsonMsg) => {
      const parsed = jsonMsg.toString();
      if (parsed.includes(config.chat.yourbalance)) {
        const moneyRegex = new RegExp(config.chat.moneyRegex.pattern, config.chat.moneyRegex.flags);
        const match = parsed.match(moneyRegex);
        if (match) {
          bot.removeListener('message', listener);
          resolve(parseInt(match[1].replace(/,/g, ''), 10));
        }
      }
    };
    bot.on('message', listener);
    bot.chat('/bal');
  });
}

function loadShop() {
  try {
    const file = fs.readFileSync('./settings/shop.yml', 'utf8');
    shop = yaml.load(file) || [];
    if (!Array.isArray(shop)) shop = [];
    console.log(
      chalk.bold.hex('#ffd900')(t('bot.shop_prefix')) + ' ' +
      chalk.hex('#7DFF7C')(t('bot.shop_loaded'))
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#ffd900')(t('bot.shop_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.errorload')}: ${err}`)
    );
    shop = [];
  }
}
loadShop();

export function saveShop() {
  try {
    const file = yaml.dump(shop, { lineWidth: -1 });
    fs.writeFileSync('./settings/shop.yml', file, 'utf8');
  } catch (err) {
    console.error('', err);
  }
}

fs.watchFile('./settings/shop.yml', () => {
  console.log(
    chalk.bold.hex('#ffd900')(t('bot.shop_prefix')) + ' ' +
    chalk.hex('#e7ff7c')(t('bot.update'))
  );
  loadShop();
});


function loadPurchases() {
  try {
    const file = fs.readFileSync('./settings/purchases.yml', 'utf8');
    purchases = yaml.load(file) || {};
  } catch {
    purchases = {};
  }
}

export function savePurchases() {
  fs.writeFileSync('./settings/purchases.yml', yaml.dump(purchases, { indent: 2, lineWidth: -1 }), 'utf8');
}

loadPurchases();

function loadCodes() {
  try {
    const file = fs.readFileSync(codesFile, 'utf8');
    codesCache = yaml.load(file) || {};
    console.log(
      chalk.bold.hex('#ff1d3b')(t('bot.codes_prefix')) + ' ' +
      chalk.hex('#7DFF7C')(t('bot.codes_loaded'))
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#ff1d3b')(t('bot.codes_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.errorload')}: ${err}`)
    );
    codesCache = {};
  }
}

loadCodes();
fs.watchFile(codesFile, () => {
  console.log(
    chalk.bold.hex('#ff1d3b')(t('bot.codes_prefix')) + ' ' +
    chalk.hex('#FFEA48')(t('bot.update'))
  );
  loadCodes();
});

let broadcastInterval = null;

export function getSymbol(input) {
  const map = {
    '1': '&c⚠',
    '2': '&e📢',
    '3': '&6🔥',
    '4': '&b💎',
    '5': '&c🚨',
    '6': '&#11CCBF⚡',
    '7': '&#FFE600⭐',
    '8': '&#DBFEFF❄',
    '9': '&#FFB700☀',
    '10': '&#DA4DFF☄',
    '11': '&#78D67E✈',
    '12': '&#8DA6F0⌚'
  };

  return map[input] || input;
}

function broadcast(symbol, text) {
  const formatted = `&8[${symbol}&8]&f ${text}`;
  bot.chat(`/me ${formatted}`);
}

export function startBroadcast(symbol, text, intervalSec) {
  stopBroadcast();

  broadcast(symbol, text);

  if (Number.isFinite(intervalSec) && intervalSec > 0) {
    broadcastInterval = setInterval(() => {
      broadcast(symbol, text);
    }, intervalSec * 1000);
  }
}

export function stopBroadcast() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
    broadcastInterval = null;
  }
}

async function processUserCommand(realUsername, message, source = 'mc', originalSender = null) {
  const isConsole = realUsername === 'SYSTEM';
  const originalCasedUsername = isConsole ? 'SYSTEM' : realUsername;
  const displayName = source === 'discord' && originalSender ? originalSender : originalCasedUsername;

  if (realUsername === 'Unknown Player') return;
  if (config.killswitch && source !== 'discord') return;

  const trimmed = (message || '').trim();
  if (!trimmed.startsWith(config.botprefix)) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(config.botprefix, '');

  const canRun = await preCommandCheck({ cmd, parts, source, displayName, realUsername, isConsole, message });
  if (!canRun) return;

  try {
    if (commands[cmd]) {
      await commands[cmd]({ source, displayName, originalSender, parts, config, languages });
      return;
    }

    if (pluginCommands[cmd]) {
      const plugin = [...plugins.values()].find(p => p.commands.includes(cmd));
      if (plugin?.active) {
        await pluginCommands[cmd]({ source, displayName, originalSender, parts });
        return;
      }
    }

    if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.notfound', { cmd, prefix: config.botprefix })}`);
    else await outputToDiscord(`${t('bot.cmd.notfounddc', { cmd, prefix: config.botprefix })}`);

  } catch (err) {
    console.error(`${t('bot.cmd.error_occured', { cmd })}:`, err);
    if (source === 'discord') await outputToDiscord(t('bot.cmd.error_occured', { cmd }));
  }
}

bot.on('login', () => {
  console.log(
    chalk.bold.hex('#61EFFF')(t('other.bot.prefix')) + ' ' +
    chalk.hex('#acacac')(t('other.bot.logged'))
  );
});

bot.once('spawn', async () => {
  if (config.gui.cmd.enable) setTimeout(() => bot.chat(`/${config.gui.cmd.cmd}`), 1000);
  else {
    bot.setQuickBarSlot(config.gui.hotbar_slot);
    bot.activateItem();
  }
  setTimeout(() => fullySpawned = true, 5000);
});

bot.on('playerJoined', (player) => {
  const timestamp = getFormattedTimestamp();
  if (!player?.username) return;
  if (!fullySpawned) {
    seenPlayers.add(player.username);
    return;
  }
  if (seenPlayers.has(player.username)) return;

  seenPlayers.add(player.username)
  const msg = `${timestamp}\n🟢 ${t('other.player.join', { username: player.username })}`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

bot.on('playerLeft', (player) => {
  const timestamp = getFormattedTimestamp();
  if (!player?.username) return;
  seenPlayers.delete(player.username)
  const msg = `${timestamp}\n🔴 ${t('other.player.left', { username: player.username })}`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

const pendingRealnames = new Map();

bot.on('title', json => {
  const parsed = parseColoredText(json, mclang);
  console.log('Title:', parsed);
});

bot.on('actionBar', json => {
  const parsed = parseColoredText(json, mclang);
  console.log('ActionBar:', parsed);
});

bot.on('message', async (jsonMsg, position) => {

  if (position === 'game_info') return;

  const parsed = jsonMsg.toString();
  const colored = (parseColoredText(jsonMsg?.unsigned?.json || jsonMsg?.json || jsonMsg, mclang) + '').replace(/§[xr]/gi, '');
  const translateKey = jsonMsg.json?.translate || jsonMsg?.translate;
  if (translateKey === 'sleep.players_sleeping') return;
  if (parsed) console.log(colored);

  const arrowSymbol = config.chat.arrowSymbol;
  const arrowIndex = parsed.lastIndexOf(arrowSymbol);

  if (config.autoconsole && parsed.includes(config.chat.autoconsole_trigger)) {
    bot.chat("/console");
  }

  if (parsed.startsWith(t('other.proxy.msg1')) || parsed.startsWith("Exception Connecting:ReadTimeoutException : null") || parsed.startsWith(t('other.proxy.msg2')) || parsed.startsWith("Exception Connecting:NativeIoException : io_uring read(..) failed with error(-104): Connection reset by peer")) {
    try {
      bot.setQuickBarSlot(config.gui.hotbar_slot)
      bot.activateItem()

      const slotIndex = config.gui.slot;
      const slot = window.slots[slotIndex];

      setTimeout(() => {
        bot.clickWindow(slot.slot, 0, 0);
      }, 1500);
    } catch (err) {
      console.error(chalk.hex('#FF0000')(`${t('bot.error_prefix')}: ${err}`));
    }
  }

  const coinConvertRegex = new RegExp(config.chat.coinConvertRegex.pattern, config.chat.coinConvertRegex.flags);
  const match1 = parsed.match(coinConvertRegex);

  if (match1) {
    const money = parseInt(match1[1].replace(/,/g, ''), 10);
    let username = match1[2].trim();
    if (money === 0) return;

    if (config.killswitch) return;

    if (await isBlacklisted(username)) return;

    if (username.startsWith('~')) {

      requestRealName(username);

      if (!pendingRealnames.has(username)) {
        pendingRealnames.set(username, { coins: 0, logs: [], commands: [], answers: [], aimsg: [] });
      }
      const data = pendingRealnames.get(username);
      data.coins = (data.coins || 0) + money;

      return;
    }

    if (money < config.mindeposit) {
      bot.chat(`/m ${username} ${t('bot.mindeposit', { min: config.mindeposit })}`);
      bot.chat(`/pay ${username} ${money}`);
      return;
    }

    await changeBalance(username, money);
    bot.chat(`/m ${username} ${t('bot.deposit', { amount: money.toLocaleString('de-DE') })}`);
    await outputToDiscord(`${t('bot.notifydeposit', { username, amount: money.toLocaleString('de-DE') })}`)
  }

  if (globals.pendingDiscordRun) {
    if (parsed?.trim()) globals.collectedRunOutput.push(parsed.trim());
    if (globals.runTimeout) clearTimeout(globals.runTimeout);
    globals.runTimeout = setTimeout(async () => {
      if (globals.collectedRunOutput.length > 0) {
        const combined = globals.collectedRunOutput.join('\n');
        if (globals.pendingDiscordRun.source === 'discord')
          await outputToDiscord(`${combined}`);
      } else if (globals.pendingDiscordRun?.source === 'discord') {
        await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.cmd.run.executing')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `${t('bot.cmd.run.nomsg', { cmd: globals.pendingDiscordRun.command })}`, inline: true }], timestamp: true })] });
      }
      globals.pendingDiscordRun = null;
      globals.collectedRunOutput = [];
    }, 500);
  }

  const realnameRegex = new RegExp(config.chat.realnameRegex);
  const realnameMatch = parsed.match(realnameRegex);
  if (realnameMatch) {
    const displayNick = `~${realnameMatch[1]}`
    const realNick = realnameMatch[2];
    nickMap.set(displayNick, realNick);

    if (pendingRealnames.has(displayNick)) {
      const data = pendingRealnames.get(displayNick);

      if (data.coins) {
        if (realNick === 'Unknown Player') return;

        if (data.coins < config.mindeposit) {
          bot.chat(`/m ${realNick} ${t('bot.mindeposit', { min: config.mindeposit })}`);
          bot.chat(`/pay ${realNick} ${data.coins}`);
          return;
        }

        await changeBalance(realNick, data.coins);
        bot.chat(`/m ${realNick} ${t('bot.deposit', { amount: data.coins.toLocaleString('de-DE') })}`);
        await outputToDiscord(`${t('bot.notifydeposit', { username: realNick, amount: data.coins.toLocaleString('de-DE') })}`)
      }

      for (const log of data.logs) {
        await logToDiscordChatLog(`${log.timestamp} 💬 **\`${realNick}\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
      }

      for (const cmd of data.commands) {
        try {
          await ensureUser(realNick);
          await processUserCommand(realNick, cmd);
        } catch (err) {
          console.error(
            chalk.bold.hex('#FF0000')(t('bot.error_prefix')) + ' ' +
            chalk.hex('#ff8282')('processUserCommand (pending cmds):', err)
          );
        }
      }

      for (const ans of data.answers) {
        if (awaitingAnswer && currentGame && ans.toLowerCase() === currentGame.answer.toLowerCase()) {
          giveGameReward(realNick);
        }
      }

      for (const ai of data.aimsg) {
        await processAI(realNick, ai);
      }

      pendingRealnames.delete(displayNick);
    }
    return;
  }

  if (parsed.startsWith(config.chat.unknown_player)) {
    if (pendingRealnames.size > 0) {
      for (const [displayNick, data] of pendingRealnames.entries()) {
        nickMap.set(displayNick, "Unknown Player");

        for (const log of data.logs) {
          await logToDiscordChatLog(`${log.timestamp} 💬 **\`Unknown Player\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
        }

        pendingRealnames.delete(displayNick);
      }
    }
  }

  let usernameRaw = '';
  let msgText = '';

  if (arrowIndex !== -1) {
    const left = parsed.slice(0, arrowIndex).trim();
    usernameRaw = left.split(/\s+/).pop();
    msgText = parsed.slice(arrowIndex + arrowSymbol.length).trim();

    if (usernameRaw.startsWith('~')) {
      const realnameMatch = parsed.match(realnameRegex);
      if (realnameMatch) {
        usernameRaw = realnameMatch[2];
        nickMap.set(`~${realnameMatch[1]}`, usernameRaw);
      }
    }

    if (!usernameRaw.startsWith('~') && msgText.startsWith(config.botprefix)) {
      await ensureUser(usernameRaw);
    }

    await handleChat(usernameRaw, msgText, parsed, jsonMsg, 'mc');

  } else {
    usernameRaw = parsed.split(/\s+/)[0];
    msgText = parsed;
    await handleChat(usernameRaw, msgText, parsed, jsonMsg, 'other');
  }
});

bot.once('windowOpen', (window) => {
  const title = window.title?.value?.text?.value;
  console.log(
    chalk.bold.hex('#FF70C3')(t('other.gui.prefix')) + ' ' +
    chalk.hex('#ffafde')(`${t('other.gui.window_opened')}: ${title}`)
  );

  if (title.toLowerCase().includes(config.gui.title)) {
    const slotIndex = config.gui.slot;
    const slot = window.slots[slotIndex];
    if (slot) {
      bot.clickWindow(slot.slot, 0, 0);
      console.log(
        chalk.bold.hex('#FF70C3')(t('other.gui.prefix')) + ' ' +
        chalk.hex('#ffafde')(t('other.gui.slotclicked', { slot: slot.slot, name: slot.name }))
      );
    } else {
      console.log(
        chalk.bold.hex('#FF70C3')(t('other.gui.prefix')) + ' ' +
        chalk.hex('#ffafde')(t('other.gui.emptyslot'))
      );
    }
  }
});

function itemDisplayName(component) {
  if (!component) return '';
  if (typeof component === 'string') return component;

  let result = '';
  if (component.text) result += component.text;

  if (component.extra && Array.isArray(component.extra)) {
    for (const extra of component.extra) {
      result += itemDisplayName(extra);
    }
  }

  return result;
}


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.on('line', async (input) => {
  if (!bot || !bot.chat) return;

  const trimmed = input.trim();
  const lowered = trimmed.toLowerCase();

  const consoleCommands = ['blacklist', 'eco', 'cmd', 'ban', 'unban', 'exit', 'info', 'bcode', 'restart', 'role'];

  if (consoleCommands.some(cmd => lowered.startsWith(config.botprefix + cmd))) {
    await processUserCommand('SYSTEM', trimmed);

  } else if (trimmed.startsWith('menu.slot.')) {
    const slotStr = trimmed.split('.')[2];
    const slot = parseInt(slotStr, 10);
    if (isNaN(slot)) {
      console.log(chalk.hex('#FF0000')(t('other.console.menu.noslot')));
      return;
    }
    if (!bot.currentWindow) {
      console.log(chalk.hex('#FF0000')(t('other.console.menu.no_opened')));
      return;
    }
    try {
      await bot.clickWindow(slot, 0, 0);
      console.log(chalk.hex('#00FF00')(t('other.console.menu.slotclicked', { slot })));
    } catch (err) {
      console.log(chalk.hex('#FF0000')(`${t('other.console.menu.click_error')}: ${err}`));
    }

  } else if (trimmed.startsWith('menu.close')) {
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
      console.log(chalk.hex('#00FF00')(t('other.console.menu.closed')));
    } else {
      console.log(chalk.hex('#FF0000')(t('other.console.menu.nomenu')));
    }

  } else if (trimmed.startsWith('menu.show')) {
    if (bot.currentWindow) {
      console.log(chalk.hex('#00FF00')(t('other.console.menu.content')));
      bot.currentWindow.slots.forEach((item, index) => {
        if (item) {
          const idName = item.name;
          const rawName = item?.nbt?.value?.display?.value?.Name?.value;
          const displayName = rawName ? itemDisplayName(JSON.parse(rawName)) : idName;
          console.log(chalk.hex('#B4E781')(`[${index}] ${idName} x${item.count} (${displayName})`));
        }
      });
    } else {
      console.log(chalk.hex('#FF0000')(t('other.console.menu.nomenu')));
    }

  } else if (trimmed.startsWith('discord.send ')) {
    const msg = trimmed.slice("discord.send".length).trim();
    if (!msg) {
      console.log(chalk.hex('#7CB6FF')(t('other.console.discord.send_notext')));
      return;
    }
    try {
      await discordOutput.send(msg);
      console.log(chalk.hex('#7CB6FF')(t("other.console.discord.sended")));
    } catch (err) {
      console.error(chalk.hex('#7CB6FF')(`${t('other.console.discord.send_error')}: ${err}`));
    }

  } else {
    bot.chat(trimmed);
  }
});

bot.on('error', err => {
  console.error(chalk.hex('#FF0000')(`${t('bot.error_prefix')}: ${err}`));
});

bot.on('end', (reason) => {
  console.log(
    chalk.bold.hex('#61EFFF')(t('other.bot.prefix')) + ' ' +
    chalk.hex('#acacac')(`${t('other.bot.end')}: ${reason}`)
  );
  setTimeout(() => process.exit(1), 100);
});