import 'dotenv/config';
import mineflayer from 'mineflayer';
import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import { Client, GatewayIntentBits, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { exec } from "child_process";
import chalk from "chalk";
import yaml from 'js-yaml';
import path from 'path';
import chokidar from 'chokidar';
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./bot.db');

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
    reason TEXT DEFAULT 'Без причины'
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

let config = {};

function loadConfig() {
  try {
    const file = fs.readFileSync('./settings/config.yml', 'utf8');
    config = yaml.load(file) || {};
  } catch (err) {
    console.error(
      chalk.bold.hex('#5fb857')('[Config]') + ' ' +
      chalk.hex('#ff4040')('Error:', err)
    );
    config = {};
  }
}

function saveConfig() {
  try {
    fs.writeFileSync('./settings/config.yml', yaml.dump(config, { indent: 2, lineWidth: -1 }), 'utf8');
    console.log(
      chalk.bold.hex('#5fb857')('[Config]') + ' ' +
      chalk.hex('#7DFF7C')('File saved')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#5fb857')('[Config]') + ' ' +
      chalk.hex('#ff4040')('Save error:', err)
    );
  }
}

loadConfig();

fs.watchFile('./settings/config.yml', () => {
  console.log(
    chalk.bold.hex('#5fb857')('[Config]') + ' ' +
    chalk.hex('#ffc23d')('Change detected, update...')
  );
  loadConfig();
});

const LANG_DIR = './language'
let languages = {};

function loadLanguages() {
  languages = {};
  for (const file of fs.readdirSync(LANG_DIR)) {
    if (!file.endsWith('.yml')) continue;

    const lang = file.replace('.yml', '');
    languages[lang] = yaml.load(
      fs.readFileSync(path.join(LANG_DIR, file), 'utf8')
    );
  }
}

function t(key, vars = {}) {
  let text = key.split('.').reduce(
    (obj, k) => obj?.[k],
    languages[config.lang]
  );

  if (text === undefined) return key;

  if (typeof text === 'string') {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, v);
    }
  }

  return text;
}

loadLanguages();

chokidar.watch(LANG_DIR, { ignoreInitial: true }).on('change', filePath => {
  if (!filePath.endsWith('.yml')) return;

  const lang = path.basename(filePath, '.yml');
  try {
    languages[lang] = yaml.load(
      fs.readFileSync(filePath, 'utf8')
    );
    console.log(chalk.hex('#dffd99')(`🔄 Language updated: ${lang}`));
  } catch (err) {
    console.error(chalk.hex('#fd99aa')(`❌ Failed to reload ${lang}:`, err));
  }
});

const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let discordOutput = null;
let pendingDiscordRun = null;
let discordLogOutput;
const recentMessages = new Set();

const startTime = Date.now();
let lastBotCall = 0;
const botCooldown = 30000;
let currentGame = null;
let awaitingAnswer = false;
let gameTimeout = null;
const DefaultChatGameRewards = [
  { amount: 500, chance: 0.1 },
  { amount: 250, chance: 0.3 },
  { amount: 100, chance: 0.4 },
  { amount: 10, chance: 0.5 },
  { amount: 5, chance: 1.0 }
];
let purchases = {};
let shop = [];
let collectedRunOutput = [];
let runTimeout = null;
const chatLogList = [];
const seenPlayers = new Set();
let fullySpawned = false;
let activeSpammer = null;
let spammerInterval = null;

if (!process.env.AI_API_KEY) {
  console.error(chalk.hex('#FF0000')(t('errors.ai_api_key_missing')));
  process.exit(1);
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.botnick,
  version: '1.20.4'
});

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

  bot.once('spawn', async () => {
    const startType = process.env.pm_id !== undefined ? 'PM2' : 'Обычный';
    const ip = bot._client?.socket?.remoteAddress || bot.options?.host || 'Не указан';
    const port = bot._client?.socket?.remotePort || bot.options?.port || 'Не указан';
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

    if (msg.author.id && !roles.has('1397205134957609030')) {
      await discordOutput.send({ embeds: [sendEmbed(`⛔ ${t('discord.accessdenied')}`, ``, { color: 0x5499f4, footer: 'DENIED', fields: [{ name: `${t('discord.noaccess')}`, value: `\`\`\`${content}\`\`\``, inline: true }], timestamp: true })] });
      return;
    }

    await processUserCommand('CONSOLE', content, 'discord', msg.member.displayName);

  } catch (err) {
    console.error(
      chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
      chalk.hex('#FF7C7C')(`${t('discord.command_processing_error')}: ${err}`)
    );
    await msg.reply(`${t('discord.msg_command_processing_error')}`);
  }
});

let cachedDatabaseRows = [];

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('db_')) return;

  try {
    if (!cachedDatabaseRows || !cachedDatabaseRows.length) {
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
    const totalPages = Math.ceil(cachedDatabaseRows.length / pageSize);

    page = Math.max(0, Math.min(page, totalPages - 1));

    const embed = buildDatabaseEmbed(cachedDatabaseRows, page, pageSize);
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

function parseColoredText(component) {
  if (!component) return '';

  if (typeof component === 'string') return component;
  if (typeof component !== 'object') return String(component);

  let chalkFn = chalk;

  if (component.color) {
    const mapped = legacyColors[component.color] || component.color;
    if (mapped.startsWith('#')) {
      chalkFn = chalkFn.hex(mapped);
    }
  }

  if (component.bold) chalkFn = chalkFn.bold;
  if (component.italic) chalkFn = chalkFn.italic;
  if (component.underlined) chalkFn = chalkFn.underline;
  if (component.strikethrough) chalkFn = chalkFn.strikethrough;
  if (component.obfuscated) chalkFn = chalkFn.inverse;


  let result = '';

  if (component.text) result += chalkFn(component.text);
  if (component['']) result += chalkFn(component['']);

  if (component.translate && Array.isArray(component.with)) {
    for (const w of component.with) {
      result += parseColoredText(w);
    }
  }

  if (component.extra && Array.isArray(component.extra)) {
    for (const e of component.extra) {
      result += parseColoredText(e);
    }
  }

  return result;
}


function parseFormattedMessage(msgObj) {
  if (!msgObj) return '';

  let result = '';

  if (typeof msgObj.text === 'string') {
    result += msgObj.text;
  }

  if (typeof msgObj[''] === 'string') {
    result += msgObj[''];
  }

  if (Array.isArray(msgObj.extra)) {
    for (const part of msgObj.extra) {
      result += parseFormattedMessage(part);
    }
  }

  if (Array.isArray(msgObj.with)) {
    for (const part of msgObj.with) {
      result += parseFormattedMessage(part);
    }
  }

  return result;
}

async function outputToDiscord(message) {
  if (!discordOutput) return;

  try {
    let cleanMessage = '';

    if (typeof message === 'object' && message.json) {
      cleanMessage = parseFormattedMessage(message.json);
    } else if (typeof message === 'string') {
      try {
        const maybeJson = JSON.parse(message);
        cleanMessage = parseFormattedMessage(maybeJson);
      } catch {
        cleanMessage = message;
      }
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

async function resolveUserArg(arg) {
  if (!arg) return null;

  const idMatch = /^:(\d+)$/.exec(arg);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    const row = await new Promise((res, rej) =>
      db.get('SELECT nickname FROM users WHERE id = ?', [id], (err, r) => err ? rej(err) : res(r))
    );
    return row?.nickname ?? null;
  }

  return arg;
}

function buildDatabaseEmbed(rows, page = 0, pageSize = 10) {
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

function buildButtons(page, totalPages) {
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

function sendEmbed(
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
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'Your Model',
        messages: [
          {
            role: 'system',
            content:
              'Your Content'
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
    text = limitCharsByWords(text, 240);

    return text;

  } catch (err) {
    const errorText = (err.message || String(err)).slice(0, 80);
    bot.chat(`/me ${t('bot.ai_unavailable')} &8(&6${errorText}&8)`);
    console.error('[AI]', err);
  }
}

let roles = {};

function loadRoles() {
  try {
    roles = yaml.load(fs.readFileSync('./settings/roles.yml', 'utf8')) || {};
  } catch (e) {
    console.error(e);
    roles = {};
  }
}

function saveRoles() {
  fs.writeFileSync('./settings/roles.yml', yaml.dump(roles, { lineWidth: -1 }));
}

loadRoles();

function getRoles() {
  return roles;
}


async function isBlacklisted(username) {
  if (username === 'CONSOLE') return false;
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

async function addToBlacklist(username) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO blacklist (nickname) VALUES (?)',
      [username],
      err => err ? reject(err) : resolve()
    );
  });
}

async function removeFromBlacklist(username) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM blacklist WHERE nickname = ?',
      [username],
      err => err ? reject(err) : resolve()
    );
  });
}

async function getBlacklist() {
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
  const lower = nickOrDisplayName.toLowerCase();

  for (const [realUsername, playerData] of Object.entries(bot.players)) {
    if (!playerData || !playerData.username) continue;

    const displayName = playerData.displayName?.toString()?.toLowerCase();
    if (displayName === lower || realUsername.toLowerCase() === lower) {
      return realUsername;
    }
  }

  return nickOrDisplayName;
}

function getRole(nickname) {
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
    db.all('SELECT id FROM users ORDER BY id', [], (err, rows) => {
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
  if (nickname === 'CONSOLE') return;
  const nextId = await getNextId();

  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO users (id, nickname, role, balance) VALUES (?, ?, ?, ?)',
      [nextId, nickname, 'user', 0],
      (err) => err ? reject(err) : resolve()
    );
  });
}

async function hasPermission(username, cmd) {
  if (!username || !cmd) return false;

  if (username === 'CONSOLE') return true;

  const role = await getRole(username);
  const roleData = roles[role];
  if (roleData) {
    const cmds = roleData.cmds || [];
    if (cmds.includes(cmd)) return true;
  }

  const user = username.toLowerCase();
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

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / (1000 * 60)) % 60;
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

async function grantPermission(nickname, command) {
  if (!nickname || !command) return;

  nickname = nickname.toLowerCase();
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

async function revokePermission(nickname, command) {
  if (!nickname || !command) return;

  nickname = nickname.toLowerCase();
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

async function getUserExtraPerms(nickname) {
  const user = nickname.toLowerCase();

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

function giveGameReward(username) {
  awaitingAnswer = false;
  const reward = pickReward(currentGame.rewards);
  if (reward) {
    changeBalance(username.toLowerCase(), reward);
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswer')} &e${reward}⛃!`);
  } else {
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswererror')}`);
  }
  currentGame = null;
}

async function processAI(realNick, msgText, source = 'mc') {

  if (checkBan(realNick)) return;

  if (isBlacklisted(realNick)) {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${realNick}, ${t('bot.blacklisted')}`);
    return;
  }

  const now = Date.now();
  if (now - lastBotCall < botCooldown) {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${realNick}, ${t('bot.ai_cooldown')}`);
    return;
  }
  lastBotCall = now;

  const parts = msgText.toLowerCase().split('бот,');
  if (parts.length < 2) return;

  const prompt = parts[1].trim();
  if (!prompt) return;

  await bot.chat(`/m ${realNick} ${t('bot.ai_think')}`);
  const reply = await queryAI(prompt);
  await sendLongMessage(realNick, reply);
}

async function handleChat(usernameRaw, msgText, parsed, jsonMsg) {
  try {
    const username = cleanName(usernameRaw);
    const timestamp = getFormattedTimestamp();

    if (isDuplicateMessage(username, msgText)) return;

    if (/^(❤ )?\[(ɢ|ʟ)\]/i.test(parsed) && msgText.toLowerCase().includes('бот,')) {

      if (usernameRaw.startsWith('~')) {
        const displayNick = usernameRaw.toLowerCase();

        if (!pendingRealnames.has(displayNick))
          pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [], aimsg: [] });

        pendingRealnames.get(displayNick).aimsg.push(msgText);

        requestRealName(usernameRaw);
        return;
      }

      await processAI(usernameRaw, msgText);
      return;
    }

    const arrowSymbol = '⇨'
    const arrowIndex = parsed.lastIndexOf(arrowSymbol);

    if (awaitingAnswer && currentGame && arrowIndex !== -1) {
      const leftPart = parsed.slice(0, arrowIndex).trim();
      const answerText = parsed.slice(arrowIndex + 1).trim();
      let usernameRaw = leftPart.split(/\s+/).pop();

      if (usernameRaw.startsWith('~')) {
        const displayNick = usernameRaw.toLowerCase();
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
      parsed.includes('[ʟ]') || parsed.includes('[ɢ]') ||
      parsed.startsWith('[я ->') || parsed.includes('-> я]') ||
      parsed.startsWith('[SS]');

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

      if (parsed.includes(arrowSymbol) && !/^❤?\s?\[(ɢ|ʟ)\]\s?/i.test(parsed)) {
        await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.suspiciousactivity')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${parsed}`, value: ``, inline: true }], timestamp: true })] });
        return;
      }

      if (/^(❤ )?\[(ɢ|ʟ)\]/i.test(parsed)) {
        const leftPart = parsed.slice(0, arrowIndex).trim();
        let usernameRaw = leftPart.split(/\s+/).pop();
        if (arrowIndex !== -1) {
          if (usernameRaw.startsWith('~')) {
            const displayNick = usernameRaw.toLowerCase();
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
            await processUserCommand(usernameRaw, msgText);
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

    await processUserCommand(usernameRaw, msgText);
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

async function banUser(username, durationMs, reason) {
  const unbanAt = Date.now() + durationMs;
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO bans (nickname, unbanAt, reason) VALUES (?, ?, ?)`,
      [username, unbanAt, reason],
      err => err ? reject(err) : resolve()
    );
  });
}

async function unbanUser(username) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM bans WHERE nickname = ?', [username], err => err ? reject(err) : resolve());
  });
}

async function isBanned(username) {
  if (username === 'CONSOLE') return false;
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

async function checkBan(username) {
  if (username === 'CONSOLE') return false;
  const banInfo = await isBanned(username);
  if (banInfo) {
    const msLeft = banInfo.unbanAt - Date.now();
    const timeLeft = formatDuration(msLeft);
    bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.bot_blocked', { username: originalCasedUsername, timeLeft: timeLeft, reason: banInfo.reason })}`);
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

async function getBalance(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT balance FROM users WHERE nickname = ?', [username], (err, row) => {
      if (err) return reject(err);

      if (!row) {
        db.run('INSERT INTO users (nickname, role, balance) VALUES (?, ?, ?)', [username, 'user', 0], (err2) => {
          if (err2) return reject(err2);
          resolve(0);
        });
      } else {
        resolve(row.balance);
      }
    });
  });
}

async function changeBalance(username, amount) {
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
function savePurchases() {
  fs.writeFileSync('./settings/purchases.yml', yaml.dump(purchases, { indent: 2, lineWidth: -1 }), 'utf8');
}
loadPurchases();

let codesCache = {};
const CODES_FILE = './settings/codes.yml';

function loadCodes() {
  try {
    const file = fs.readFileSync(CODES_FILE, 'utf8');
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
fs.watchFile(CODES_FILE, () => {
  console.log(
    chalk.bold.hex('#ff1d3b')(t('bot.codes_prefix')) + ' ' +
    chalk.hex('#FFEA48')(t('bot.update'))
  );
  loadCodes();
});

async function processUserCommand(realUsername, message, source = 'mc', originalSender = null) {
  const isConsole = realUsername === 'CONSOLE';
  const originalCasedUsername = isConsole ? 'CONSOLE' : resolveUsername(realUsername);
  const displayName = source === 'discord' && originalSender ? originalSender : originalCasedUsername;

  const bannedRunCommands = [
    '/sphere', '/cyl', '/hcyl', '/walls', '/set', '/faces', '/overlay',
    '/hsphere', '/pyramid', '/hpyramid', '/outline', '/replacenear', '/replace',
    '/removenear', '/frb', '/snow', 'hub'
  ];
  const discordBlockedCommands = ['pay', 'balance', 'feedback', 'code', 'bcode', 'shop'];
  const alwaysAllowed = ['help', 'info', 'feedback', 'balance', 'pay', 'shop', 'code'];

  const trimmed = (message || '').trim();
  if (!trimmed.startsWith(config.botprefix)) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(config.botprefix, '');

  if (source === 'discord' && discordBlockedCommands.includes(cmd)) {
    await outputToDiscord(`${t('bot.cmd.discordblocked', { prefix: config.botprefix, cmd })}`);
    return;
  }

  if (await checkBan(realUsername)) return;

  if (await isBlacklisted(realUsername)) {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.blacklisted')}`);
    return;
  }

  if (!alwaysAllowed.includes(cmd) && !isConsole) {
    if (!(await hasPermission(displayName, cmd))) {
      await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.noperm')} &e${config.botprefix}${cmd}!`);
      return;
    }
  }

  if (config.testmode && source == 'mc') {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.testmode')}`);
    return;
  }

  switch (cmd) {
    case 'help': {
      const effectiveUsername = source === 'discord' ? originalSender : realUsername;
      const roleName = await getRole(effectiveUsername);

      const rolesData = getRoles();
      const roleInfo = rolesData[roleName] || { cmds: [] };
      const baseCommands = roleInfo.cmds || [];

      const extraPerms = await getUserExtraPerms(effectiveUsername)
      const allCommands = [...new Set([...baseCommands, ...extraPerms, ...alwaysAllowed])];

      const commandDescriptions = t('bot.cmd.descriptions') || {};

      if (source === 'discord') {
        const detailedList = allCommands
          .map(cmd => `${config.botprefix}${cmd} » ${commandDescriptions[cmd] || '???'}`)
          .join('\n');

        await outputToDiscord(detailedList);
      } else {
        const withPrefix = allCommands.map(c => config.botprefix + c);
        await bot.chat(
          `/me &8[&e🛈&8] &e${displayName}, ${t('bot.cmd.availablecmds')} &e${withPrefix.join(', ')}`
        );
      }

      break;
    }

    case 'info': {
      const uptime = Date.now() - startTime;
      const formatted = formatUptime(uptime);
      const ip = bot._client?.socket?.remoteAddress || bot.options?.host || 'Не указан';
      const port = bot._client?.socket?.remotePort || bot.options?.port || 'Не указан';
      const ipPort = `${ip}:${port}`;
      const discordPing = discordClient.ws.ping;
      const mcPing = bot.player?.ping ?? '-';
      if (source === 'mc') {
        const roleName = await getRole(displayName);
        const roleData = roles[roleName];
        const roleDisplay = roleData?.display || "&7???";
        await bot.chat(`/me &8[&e✦&8] ${t('bot.cmd.info', { displayName: displayName, prefix: config.botprefix, uptime: formatted, role: roleDisplay })}`);
      } else {
        await discordOutput.send({ embeds: [sendEmbed(`ℹ️ ${t('bot.cmd.info_dc.info')}`, ``, { color: 0x5499f4, footer: 'INFO', fields: [{ name: `${t('bot.cmd.info_dc.creator')}`, value: `**exillrei**`, inline: true }, { name: `${t('bot.cmd.info_dc.help')}`, value: `**${config.botprefix}help**`, inline: true }, { name: `${t('bot.cmd.info_dc.uptime')}`, value: `**${formatted}**`, inline: true }, { name: `${t('bot.cmd.info_dc.connection')}`, value: `**${ipPort}**`, inline: true }, { name: `${t('bot.cmd.info_dc.online')}`, value: `**${Object.keys(bot.players).length}**`, inline: true }, { name: `${t('bot.cmd.info_dc.ping')}`, value: `**${mcPing}/${discordPing}**`, inline: true }], timestamp: true })] });
      }
      break;
    }

    case 'msg': {
      const msgText = parts.slice(1).join(' ').trim();
      if (!msgText) break;

      if (msgText.includes(config.botprefix)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}`);
        }
        break;
      }

      if (config.msg_hidename) {
        await bot.chat(`!${msgText}`);
      } else {
        await bot.chat(`!${t('bot.cmd.msg.from')} &a${displayName}: ${msgText}`);
      }

      if (source === 'discord') await outputToDiscord(`${t('bot.cmd.msg.dcsubmitted')}`);
      break;
    }

    case 'run': {
      const cmdToRun = parts.slice(1).join(' ').trim();
      const cmdLower = cmdToRun.toLowerCase();

      if (!cmdToRun) break;

      if (cmdToRun.includes(config.botprefix)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
        }
        break;
      }

      if (bannedRunCommands.some(b => cmdLower.startsWith(b))) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.run.blockedcmd')}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.run.blockedcmd')}`);
        }
        break;
      }

      await bot.chat(`/${cmdToRun}`);

      pendingDiscordRun = { command: cmdToRun, source };
      collectedRunOutput = [];

      if (runTimeout) clearTimeout(runTimeout);
      runTimeout = setTimeout(async () => {
        if (pendingDiscordRun && collectedRunOutput.length > 0) {
          const combined = collectedRunOutput.join('\n');
          if (pendingDiscordRun.source === 'discord') {
            await outputToDiscord(`${combined}`);
          }
        } else {
          if (pendingDiscordRun?.source === 'discord') {
            await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.cmd.run.executing')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `\`\`\`${t('bot.cmd.run.nomsg', { cmd: pendingDiscordRun.command })}\`\`\``, inline: true }], timestamp: true })] });
          }
        }
        pendingDiscordRun = null;
        collectedRunOutput = [];
      }, 500);

      break;
    }

    case 'exit': {
      if (source === 'mc') await bot.chat(`/me &8[&#FF0000⏻&8] ${t('bot.cmd.exit.exitbot')}`);
      if (source === 'discord') await outputToDiscord(`${t('bot.cmd.exit.exitbot_dc')}`);
      console.log(chalk.hex('#61EFFF')(`${t('bot.cmd.exit.logconsole')}`));

      if (process.env.pm_id !== undefined) {
        const parentPid = process.ppid;
        if (process.platform === "win32") {
          exec(`taskkill /c /PID ${process.pid} /T /F & taskkill /PID ${parentPid} /T /F`, (err, stdout, stderr) => {
            if (err) console.error(chalk.hex('#FF7C7C')(`${t('bot.cmd.exit.error')}: ${err}`));
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
          });
        } else if (process.platform === "linux") {
          exec(`kill -9 ${process.pid} ${parentPid}`, (err, stdout, stderr) => {
            if (err) console.error(chalk.hex('#FF7C7C')(`${t('bot.cmd.exit.error')}: ${err}`));
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
          });
        } else {
          console.log(chalk.hex('#61EFFF')(`${t('bot.cmd.exit.unknownplatform')}`));
          process.exit(0);
        }

      } else {
        process.exit(0);
      }
      break;
    }

    case 'restart': {
      if (process.env.pm_id !== undefined) {
        if (source === 'mc') await bot.chat(`/me &8[&#00FF00⟳&8] ${t('bot.cmd.restart.restarting')}`);
        if (source === 'discord') await outputToDiscord(`${t('bot.cmd.restart.restarting_dc')}`);
        console.log(chalk.hex('#61EFFF')(`${(t('bot.cmd.restart_logconsole'))}`));

        exec(`pm2 restart ${process.env.pm_id}`, (err, stdout, stderr) => {
          if (err) console.error(chalk.hex('#FF7C7C')(`${t('bot.cmd.restart.error')}: ${err}`));
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
          process.exit(0);
        });
      } else {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd_restart.launchtype')}`);
        if (source === 'discord') await outputToDiscord(`${t('bot.cmd.restart.launchtype_dc')}`);
      }
      break;
    }

    case 'blacklist': {
      const subcmd = parts[1]?.toLowerCase();
      const target = parts[2];

      if (!['add', 'remove', 'info'].includes(subcmd || '')) {
        if (source === 'mc')
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.blacklist.usage', { prefix: config.botprefix })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.usagedc', { prefix: config.botprefix })}`);
        return;
      }

      if (subcmd === 'info') {
        const list = await getBlacklist();

        if (!list.length) {
          if (source === 'mc')
            await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &c${t('bot.cmd.blacklist.empty')}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.empty')}`);
        } else {
          if (source === 'mc')
            await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &a${t('bot.cmd.blacklist.list', { list: list.join(', ') })}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.listdc', { list: list.join(', ') })}`);
        }
        break;
      }

      if (!target) {
        if (source === 'mc')
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.blacklist.usage_sub', { prefix: config.botprefix, subcmd })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.usage_subdc', { prefix: config.botprefix, subcmd })}`);
        break;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser) {
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const role = await getRole(targetUser);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
        break;
      }

      if (subcmd === 'add') {
        if (await isBlacklisted(targetUser)) {
          if (source === 'mc')
            await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.already', { user: targetUser })}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.alreadydc', { user: targetUser })}`);
        } else {
          await addToBlacklist(targetUser);
          await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.blacklist.added_mc', { by: displayName, user: targetUser })}`);
          if (source === 'discord')
            await outputToDiscord(`${t('bot.cmd.blacklist.added_dc', { user: targetUser })}`);
        }
      }

      if (subcmd === 'remove') {
        if (!(await isBlacklisted(targetUser))) {
          if (source === 'mc')
            await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.not_in', { user: targetUser })}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.not_indc', { user: targetUser })}`);
        } else {
          await removeFromBlacklist(targetUser);
          await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.blacklist.removed_mc', { by: displayName, user: targetUser })}`);
          if (source === 'discord')
            await outputToDiscord(`${t('bot.cmd.blacklist.removed_dc', { user: targetUser })}`);
        }
      }

      break;
    }

    case 'ban': {
      const target = parts[1];
      const timeStr = parts[2];
      const reason = parts.slice(3).join(' ') || 'Без причины';

      if (!target || !timeStr || !/^\d+[smhd]$/.test(timeStr)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.ban.usage', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.ban.usagedc', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser) {
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const role = await getRole(targetUser);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.ban.cannot_ban', { role: roleName })}`);
        return;
      }

      const unit = timeStr.slice(-1);
      const value = parseInt(timeStr.slice(0, -1), 10);
      const ms = unit === 's' ? value * 1000 :
        unit === 'm' ? value * 60 * 1000 :
          unit === 'h' ? value * 60 * 60 * 1000 :
            unit === 'd' ? value * 24 * 60 * 60 * 1000 : 0;

      if (!ms) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.ban.bad_time')}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.ban.bad_time')}`);
        }
        return;
      }

      await banUser(targetUser, ms, reason);

      await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.ban.success_mc', { by: displayName, user: targetUser, time: timeStr, reason })}`);
      if (source === 'discord') {
        await outputToDiscord(`${t('bot.cmd.ban.success_dc', { user: targetUser, time: timeStr, reason })}`);
      }
      break;
    }

    case 'unban': {
      const target = parts[1];
      if (!target) {
        if (source === 'mc')
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.unban.usage', { prefix: config.botprefix })}`);
        else
          await outputToDiscord(`${t('bot.cmd.unban.usagedc', { prefix: config.botprefix })}`);
        return;
      }

      const targetNick = await resolveUserArg(target);
      if (!targetNick) {
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const banInfo = await isBanned(targetNick);
      if (!banInfo) {
        if (source === 'mc')
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.unban.not_banned', { user: targetNick })}`);
        else
          await outputToDiscord(`${t('bot.cmd.unban.not_banneddc', { user: targetNick })}`);
        return;
      }

      await unbanUser(targetNick);

      await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.unban.success_mc', { by: displayName, user: targetNick })}`);
      if (source === 'discord')
        await outputToDiscord(`${t('bot.cmd.unban.success_dc', { user: targetNick })}`);

      break;
    }

    case 'cmd': {
      const subcmd = parts[1]?.toLowerCase();
      const target = parts[2];
      const targetCommand = parts[3]?.toLowerCase().replace(config.botprefix, '');

      if (!['give', 'take'].includes(subcmd || '') || !target || !targetCommand) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.cmd.usage_mc', { username: displayName, prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.cmd.usage_discord', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.usernotfound', { user: target })}`);
        } else {
          await outputToDiscord(t('bot.usernotfounddc', { user: target }));
        }
        return;
      }

      if (subcmd === 'give') {
        await grantPermission(targetUser, targetCommand);

        await bot.chat(`/me &8[&#00ff00🛈&8] &a${t('bot.cmd.cmd.give_mc', { by: displayName, user: targetUser, command: targetCommand })}`);
        if (source === 'discord') {
          await outputToDiscord(`${t('bot.cmd.cmd.give_discord', { user: targetUser, command: targetCommand })}`);
        }
      } else {
        await revokePermission(targetUser, targetCommand);

        await bot.chat(`/me &8[&#00ff00🛈&8] &a${t('bot.cmd.cmd.take_mc', { by: displayName, user: targetUser, command: targetCommand })}`);
        if (source === 'discord') {
          await outputToDiscord(`${t('bot.cmd.cmd.take_discord', { user: targetUser, command: targetCommand })}`);
        }
      }

      break;
    }

    case 'feedback': {
      const subcmd = parts[1]?.toLowerCase();

      if (!subcmd || !['send', 'random', 'info', 'total'].includes(subcmd)) {
        await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.feedback.usage', { username: displayName, prefix: config.botprefix })}`);
        return;
      }

      const file = './settings/feedback.yml';
      let feedbackData = {};
      try {
        feedbackData = yaml.load(fs.readFileSync(file, 'utf-8')) || {};
      } catch {
        feedbackData = {};
      }

      if (subcmd === 'send') {
        const feedbackText = parts.slice(2).join(' ');
        if (!feedbackText) {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${t('bot.cmd.feedback.no_text', { username: displayName })}`);
          return;
        }

        feedbackData[originalCasedUsername] = feedbackText;
        fs.writeFileSync(file, yaml.dump(feedbackData, { indent: 2, lineWidth: -1 }), 'utf-8');

        await bot.chat(`/me &8[&#00ff00✔&8] &a${t('bot.cmd.feedback.saved', { username: displayName })}`);
      }

      if (subcmd === 'random') {
        const keys = Object.keys(feedbackData);
        if (keys.length === 0) {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.feedback.empty', { username: displayName })}`);
          return;
        }

        const randomUser = keys[Math.floor(Math.random() * keys.length)];
        const feedback = feedbackData[randomUser];

        await bot.chat(`/me &8[&e🛈&8] &6${t('bot.cmd.feedback.from', { user: randomUser, text: feedback })}`);
      }

      if (subcmd === 'total') {
        const total = Object.keys(feedbackData).length;

        await bot.chat(`/me &8[&e🛈&8] &6${t('bot.cmd.feedback.total', { username: displayName, total })}`);
      }

      if (subcmd === 'info') {
        const targetUser = parts[2];
        const target = targetUser ? targetUser.toLowerCase() : null;

        if (!target) {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.feedback.info_usage', { username: displayName, prefix: config.botprefix })}`);
          return;
        }

        const feedbackEntry = Object.entries(feedbackData)
          .find(([name]) => name.toLowerCase() === target);

        if (!feedbackEntry) {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.feedback.not_found', { username: displayName, user: targetUser })}`);
          return;
        }

        const [name, feedbackText] = feedbackEntry;

        await bot.chat(`/me &8[&e🛈&8] &6${t('bot.cmd.feedback.from', { user: name, text: feedbackText })}`);
      }

      break;
    }

    case 'rape': {
      const target = parts[1];

      if (!target) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] ${t('bot.cmd.rape.usage', { username: displayName, prefix: config.botprefix })}`);
        if (source === 'discord') await outputToDiscord(`${t('bot.cmd.rape.usagedc', { prefix: config.botprefix })}`);
        return;
      }

      const diseases = [
        'спидом', 'сифилисом', 'гонореей', 'вичом', 'саркомой', 'грибком',
        'кандидозом', 'трихомониазом', 'герпесом', 'хламидозом',
        'уреаплазмозом', 'микоплазмозом', 'синдромом долбаеба'
      ];

      const randomDisease = diseases[Math.floor(Math.random() * diseases.length)];

      await bot.chat(`/me &8[&#D600FF☢&8] ${t('bot.cmd.rape.infected', { by: displayName, disease: randomDisease, user: target })}`);

      if (source === 'discord') {
        await outputToDiscord(`${t('bot.cmd.rape.infected_dc', { disease: randomDisease, user: target })}`);
      }

      break;
    }

    case 'balance': {
      const arg = parts[1];
      const username = realUsername;

      if (arg?.toLowerCase() === 'top') {
        db.all('SELECT nickname, balance FROM users ORDER BY balance DESC LIMIT 5', [], async (err, rows) => {
          if (err || !rows.length) {
            await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.top_empty')}`);
            return;
          }

          const topPlayers = rows
            .map((r, i) => `&d${i + 1}. &a${r.nickname} &7- &6${r.balance}⛃`)
            .join(' &8| ');

          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.top_list', { list: topPlayers })}`);
        });
        break;
      }

      if (arg && arg !== username) {
        const targetUser = await resolveUserArg(arg);
        if (!targetUser) {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.not_found', { username: displayName })}`);
          break;
        }

        const targetBalance = await getBalance(targetUser);
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.target', { username: displayName, target: targetUser, balance: targetBalance })}`);
        break;
      }

      const balance = await getBalance(username);
      await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.your', { username: displayName, balance })}`);
      break;
    }

    case 'eco': {
      const subcmd = parts[1]?.toLowerCase();
      const target = parts[2];
      const amount = parseInt(parts[3], 10);

      if (!['give', 'take'].includes(subcmd || '') || !target || isNaN(amount)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.usage', { username: displayName, prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.eco.usagedc', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser) {
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      if (subcmd === 'give') {
        await changeBalance(targetUser, amount);

        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.give_mc', { username: displayName, target: targetUser, amount })}`);

        if (source === 'discord')
          await outputToDiscord(`${t('bot.cmd.eco.give_dc', { target: targetUser, amount })}`);
      }

      if (subcmd === 'take') {
        await changeBalance(targetUser, -amount);

        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.take_mc', { username: displayName, target: targetUser, amount })}`);

        if (source === 'discord')
          await outputToDiscord(`${t('bot.cmd.eco.take_dc', { target: targetUser, amount })}`);
      }

      break;
    }

    case 'pay': {
      const target = parts[1];
      const amount = parseInt(parts[2], 10);
      const sender = realUsername;

      if (!target || isNaN(amount) || amount <= 0) {
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.pay.usage', { prefix: config.botprefix })}`);
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.usernotfound', { user: target })}`);
        return;
      }

      if (targetUser === sender) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.pay.self', { username: displayName })}`);
        return;
      }

      const senderBalance = await getBalance(sender);
      if (senderBalance < amount) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.pay.no_money', { username: displayName, balance: senderBalance })}`);
        return;
      }

      await changeBalance(sender, -amount);
      await changeBalance(targetUser, amount);

      await bot.chat(`/me &8[&#00FF00⛃&8] ${t('bot.cmd.pay.success', { username: displayName, target: targetUser, amount })}`);
      break;
    }

    case 'shop': {
      const subcmd = parts[1]?.toLowerCase();
      const itemId = parts[2]?.toLowerCase();
      const buyer = realUsername.toLowerCase();
      const oneTimeItems = ['rape'];

      if (!shop || !Array.isArray(shop)) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.shop.unavailable', { username: displayName })}`);
        return;
      }

      if (!subcmd) {
        const list = shop.map(i => `&e${i.name} &8(&6${i.price}⛃&8)`).join('&e, ');
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.shop.list', { username: displayName, list })}`);
        return;
      }

      if (subcmd === 'buy') {
        if (!itemId) {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.shop.usage', { prefix: config.botprefix, username: displayName })}`);
          return;
        }

        const item = shop.find(i => i.id.toLowerCase() === itemId || i.name.toLowerCase() === itemId);
        if (!item) {
          await bot.chat(`/me &8[&#00FF00⛃&8] ${t('bot.cmd.shop.not_found', { username: displayName, item: itemId })}`);
          return;
        }

        const itemKey = item.id.toLowerCase();

        if (oneTimeItems.includes(itemKey)) {
          if (!purchases[buyer]) purchases[buyer] = [];
          if (purchases[buyer].includes(itemKey)) {
            await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.shop.already_bought', { username: displayName, item: item.name })}`);
            return;
          }
        }

        const bal = getBalance(buyer);
        if (bal < item.price) {
          await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.shop.not_enough', { username: displayName, item: item.name, price: item.price })}`);
          return;
        }

        changeBalance(buyer, -item.price);

        if (oneTimeItems.includes(itemKey)) {
          purchases[buyer].push(itemKey);
          savePurchases();
        }

        if (item.command) {
          const commandToRun = item.command.replace('{player}', originalCasedUsername);
          await bot.chat(commandToRun);
        }

        await bot.chat(`/me &8[&#00FF00⛃&8] ${t('bot.cmd.shop.success', { username: displayName, item: item.name, price: item.price })}`);
      } else {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.shop.invalid_sub', { username: displayName, prefix: config.botprefix })}`);
      }
      break;
    }

    case 'code': {
      const codeName = parts[1]?.toLowerCase();
      const username = realUsername.toLowerCase();

      if (!codeName) {
        await bot.chat(`/me &8[&e🛈&8] ${t('bot.cmd.code.no_code', { username: displayName, prefix: config.botprefix })}`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd.code.not_found', { username: displayName, code: codeName })}`);
        return;
      }

      const alreadyUsed = codeObj.usedBy?.includes(username);
      if (alreadyUsed && (codeObj.perPlayerLimit ?? 1) <= 1) {
        await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd.code.already_used', { username: displayName })}`);
        return;
      }

      if (codeObj.globalLimit && (codeObj.usedTotal || 0) >= codeObj.globalLimit) {
        await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd.code.limit_reached', { username: displayName })}`);
        return;
      }

      if (codeObj.action?.type === 'money') {
        const amount = codeObj.action.amount || 0;
        changeBalance(username, amount);
        await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.code.activated_money', { username: displayName, amount })}`);
      }

      if (codeObj.action?.type === 'command') {
        const c = codeObj.action.command.replace('{player}', originalCasedUsername);
        bot.chat(c);
      }

      if (!codeObj.usedBy) codeObj.usedBy = [];
      codeObj.usedBy.push(username);
      codeObj.usedTotal = (codeObj.usedTotal || 0) + 1;
      fs.writeFileSync(CODES_FILE, yaml.dump(codesCache, { indent: 2, lineWidth: -1 }), 'utf8');
      break;
    }

    case 'bcode': {
      const codeName = parts[1]?.toLowerCase();
      if (!codeName) {
        await bot.chat(`/me &8[&e🛈&8] ${t('bot.cmd.bcode.no_code', { username: displayName, prefix: config.botprefix })}`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd.bcode.not_found', { username: displayName, code: codeName })}`);
        return;
      }

      const remaining = (codeObj.globalLimit || 0) - (codeObj.usedTotal || 0);
      let rewardInfo = '';
      switch (codeObj.action?.type) {
        case 'money': rewardInfo = `${codeObj.action.amount || 0}⛃`; break;
        case 'command': rewardInfo = 'команда бота'; break;
        default: rewardInfo = 'неизвестно';
      }

      await bot.chat(`/me ${t('bot.cmd.bcode.available', { code: codeName, remaining: Math.max(0, remaining), prefix: config.botprefix, reward: rewardInfo })}`);
      break;
    }

    case 'list': {
      if (source === 'mc') return;
      const players = Object.keys(bot.players);
      const online = players.length;

      if (online === 0) {
        outputToDiscord(`${t('bot.cmd.list.none')}`);
      } else {
        outputToDiscord(`${t('bot.cmd.list.online', { count: online, players: players.join(', ') })}`);
      }
      break;
    }

    case 'spammer': {
      if (source === 'mc') return;

      const args = message.trim().split(/\s+/).slice(1);

      if (args[0] === 'stop') {
        if (spammerInterval) {
          clearInterval(spammerInterval);
          spammerInterval = null;
          activeSpammer = null;
          outputToDiscord(`${t('bot.cmd.spammer.stopped')}`);
        } else {
          outputToDiscord(`${t('bot.cmd.spammer.not_running')}`);
        }
        break;
      }

      if (spammerInterval) {
        outputToDiscord(`${t('bot.cmd.spammer.already_running')}`);
        break;
      }

      if (args.length < 2) {
        outputToDiscord(`${t('bot.cmd.spammer.usage', { prefix: config.botprefix })}`);
        break;
      }

      const cooldown = parseInt(args[args.length - 1], 10);
      if (isNaN(cooldown) || cooldown <= 0) {
        outputToDiscord(`${t('bot.cmd.spammer.invalid_cooldown')}`);
        break;
      }

      const commandParts = args.slice(0, -1);
      const allIndex = commandParts.indexOf('all');

      let players = [];
      let cmdTemplate = [...commandParts];

      if (allIndex !== -1) {
        players = Object.keys(bot.players).filter(p => p !== bot.username);

        if (!players.length) {
          outputToDiscord(`${t('bot.cmd.spammer.no_players')}`);
          break;
        }
      }

      let index = 0;
      activeSpammer = commandParts.join(' ');

      spammerInterval = setInterval(() => {
        if (players.length) {
          const player = players[index];
          const cmd = [...cmdTemplate];
          cmd[allIndex] = player;
          bot.chat(`${cmd.join(' ')}`);
          index = (index + 1) % players.length;
        } else {
          bot.chat(`${cmdTemplate.join(' ')}`);
        }
      }, cooldown);

      outputToDiscord(`${t('bot.cmd.spammer.started', { command: activeSpammer, cooldown })}`);
      break;
    }

    case 'config': {
      if (source === 'mc') return;
      const args = message.trim().split(/\s+/).slice(1);

      const paramMeta = {
        msg_hidename: t('bot.cmd.config.msg_hidename', { prefix: config.botprefix }),
        botprefix: t('bot.cmd.config.botprefix'),
        autoconsole: t('bot.cmd.config.autoconsole'),
        testmode: t('bot.cmd.config.testmode'),
        lang: t('bot.cmd.config.lang')
      };

      const hiddenParams = ['host', 'port', 'botnick'];

      if (!args[0]) {
        let config_list = t('bot.cmd.config.list_header') + "\n";
        for (const [key, val] of Object.entries(config)) {
          if (hiddenParams.includes(key)) continue;
          const prettyName = paramMeta[key] || key;
          let display = val;
          if (typeof val === "boolean") display = val ? t('bot.yes') : t('bot.no');
          config_list += `${prettyName} (${key}): ${display}\n`;
        }
        config_list += `\n${t('bot.cmd.config.usage', { prefix: config.botprefix })}`;
        outputToDiscord(config_list);
        break;
      }

      const param = args[0];
      const value = args[1];

      if (hiddenParams.includes(param)) {
        outputToDiscord(`${t('bot.cmd.config.cannot_change', { param })}`);
        break;
      }

      if (!(param in config)) {
        outputToDiscord(`${t('bot.cmd.config.unknown_param', { param })}`);
        break;
      }

      let newValue;

      if (param === 'lang') {
        const availableLangs = Object.keys(languages);
        if (!availableLangs.includes(value)) {
          outputToDiscord(`${t('bot.cmd.config.invalid_value', { value })}. ${t('bot.cmd.config.availablelangs')} ${availableLangs.join(', ')}`);
          break;
        }
        newValue = value;
      } else if (typeof config[param] === "boolean") {
        if (!["true", "false"].includes(value.toLowerCase())) {
          outputToDiscord(`${t('bot.cmd.config.boolean_usage', { param })}`);
          break;
        }
        newValue = value.toLowerCase() === "true";
      } else if (typeof config[param] === "number") {
        newValue = parseInt(value, 10);
        if (isNaN(newValue)) {
          outputToDiscord(`${t('bot.cmd.config.invalid_value', { value })}`);
          break;
        }
      } else {
        newValue = value;
      }

      config[param] = newValue;
      saveConfig();

      const displayValue = (typeof newValue === "boolean") ? (newValue ? t('bot.yes') : t('bot.no')) : newValue;
      const prettyName = paramMeta[param] || param;

      outputToDiscord(`${t('bot.cmd.config.updated', { param: prettyName, value: displayValue })}`);
      break;
    }

    case 'role': {
      const args = parts.slice(1);
      const sub = args[0];
      const roles = getRoles();

      if (!sub) {
        await outputToDiscord(t('bot.cmd.role.usage', { prefix: config.botprefix }));
        break;
      }

      if (sub === 'add') {
        const roleName = args[1];
        const display = args.slice(2).join(' ');

        if (!roleName || !display) {
          await outputToDiscord(t('bot.cmd.role.usage_add', { prefix: config.botprefix }));
          break;
        }
        if (roles[roleName]) {
          await outputToDiscord(t('bot.cmd.role.exists', { role: roleName }));
          break;
        }

        roles[roleName] = { display, cmds: [] };
        saveRoles();
        await outputToDiscord(t('bot.cmd.role.created', { role: roleName }));
        break;
      }

      if (sub === 'remove') {
        const roleName = args[1];
        if (!roles[roleName]) {
          await outputToDiscord(t('bot.cmd.role.notfound', { role: roleName }));
          break;
        }

        delete roles[roleName];
        saveRoles();
        db.run('UPDATE users SET role = "user" WHERE role = ?', [roleName]);
        await outputToDiscord(t('bot.cmd.role.removed', { role: roleName }));
        break;
      }

      if (sub === 'set') {
        const target = args[1];
        const roleName = args[2];

        if (!target || !roles[roleName]) {
          await outputToDiscord(t('bot.cmd.role.usage_set', { prefix: config.botprefix }));
          break;
        }

        const nickname = await resolveUserArg(target);
        if (!nickname) {
          await outputToDiscord(t('bot.usernotfounddc', { user: target }));
          break;
        }

        db.run('UPDATE users SET role = ? WHERE nickname = ?', [roleName, nickname]);
        await outputToDiscord(t('bot.cmd.role.assigned', { user: nickname, role: roleName }));
        break;
      }

      if (sub === 'cmd') {
        const action = args[1];
        const roleName = args[2];
        const command = args[3];

        if (!['add', 'remove'].includes(action) || !roles[roleName] || !command) {
          await outputToDiscord(t('bot.cmd.role.usage_cmd', { prefix: config.botprefix }));
          break;
        }

        const cmds = roles[roleName].cmds || [];

        if (action === 'add') {
          if (!cmds.includes(command)) cmds.push(command);
          saveRoles();
          await outputToDiscord(t('bot.cmd.role.cmd_added', { command, role: roleName }));
          break;
        }

        if (action === 'remove') {
          roles[roleName].cmds = cmds.filter(c => c !== command);
          saveRoles();
          await outputToDiscord(t('bot.cmd.role.cmd_removed', { command, role: roleName }));
          break;
        }
      }

      await outputToDiscord(t('bot.cmd.role.unknown_sub'));
      break;
    }

    case 'database': {
      db.all('SELECT id, nickname, role, balance FROM users', [], async (err, rows) => {
        if (err) {
          outputToDiscord(`${t('db.readerror')}`);
          return;
        }

        cachedDatabaseRows = rows;

        const page = 0;
        const pageSize = 10;
        const totalPages = Math.ceil(rows.length / pageSize);

        const embed = buildDatabaseEmbed(rows, page, pageSize);
        const buttons = buildButtons(page, totalPages);

        await discordOutput.send({
          embeds: [embed],
          components: [buttons]
        });
      });

      break;
    }

    default: {
      if (source === 'mc') {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.unknowncmd', { cmd: config.botprefix + cmd })}`);
      } else {
        await outputToDiscord(`${t('bot.unknowncmd', { cmd: config.botprefix + cmd })}`);
      }
      break;
    }
  }
}

bot.on('login', () => {
  console.log(
    chalk.bold.hex('#61EFFF')(t('other.bot.prefix')) + ' ' +
    chalk.hex('#acacac')(t('other.bot.logged'))
  );
});

bot.once('spawn', async () => {
  console.log(
    chalk.bold.hex('#61EFFF')(t('other.bot.prefix')) + ' ' +
    chalk.hex('#acacac')(t('other.bot.cmdgames'))
  );
  setTimeout(() => bot.chat('/games'), 1000);
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

bot.on('message', async (jsonMsg) => {
  const text = jsonMsg.toString();
  const parsed = (parseFormattedMessage(jsonMsg?.unsigned?.json || jsonMsg?.json || jsonMsg) + '').replace(/§[xr]/gi, '');
  const colored = (parseColoredText(jsonMsg?.unsigned?.json || jsonMsg?.json || jsonMsg) + '').replace(/§[xr]/gi, '');
  if (parsed) console.log(colored);

  const arrowSymbol = '⇨'
  const arrowIndex = parsed.lastIndexOf(arrowSymbol);

  if (config.autoconsole && parsed.includes("Добро пожаловать!")) {
    bot.chat("/console");
  }

  if (parsed.startsWith("Не удалось подключить вас к серверу") || parsed.startsWith("Exception Connecting:ReadTimeoutException : null") || parsed.startsWith("Кикнут при подключении") || parsed.startsWith("Exception Connecting:NativeIoException : io_uring read(..) failed with error(-104): Connection reset by peer")) {
    try {
      await bot.chat("/games");

      setTimeout(() => {
        bot.clickWindow(21, 0, 0);
      }, 1500);
    } catch (err) {
      console.error(chalk.hex('#FF0000')(`${t('bot.error_prefix')}: ${err}`));
    }
  }

  if (pendingDiscordRun) {
    const cleanText = parseFormattedMessage(jsonMsg.json || jsonMsg);
    if (cleanText?.trim()) collectedRunOutput.push(cleanText.trim());
    if (runTimeout) clearTimeout(runTimeout);
    runTimeout = setTimeout(async () => {
      if (collectedRunOutput.length > 0) {
        const combined = collectedRunOutput.join('\n');
        if (pendingDiscordRun.source === 'discord')
          await discordOutput.send({ embeds: [sendEmbed(`🖥️ ${t('bot.cmd.run.executing')}`, ``, { color: 0x000000, footer: 'RUN', fields: [{ name: `${t('bot.cmd.run.command', { command: pendingDiscordRun.command })}`, value: `\`\`\`${combined}\`\`\``, inline: true }], timestamp: true })] });
      } else if (pendingDiscordRun?.source === 'discord') {
        await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.cmd.run.executing')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `${t('bot.cmd.run.nomsg', { cmd: pendingDiscordRun.command })}`, inline: true }], timestamp: true })] });
      }
      pendingDiscordRun = null;
      collectedRunOutput = [];
    }, 500);
  }

  const realnameMatch = parsed.match(/^~(.+?) is (\w+)/);
  if (realnameMatch) {
    const displayNick = `~${realnameMatch[1]}`.toLowerCase();
    const realNick = realnameMatch[2];
    nickMap.set(displayNick, realNick);

    if (pendingRealnames.has(displayNick)) {
      const data = pendingRealnames.get(displayNick);

      for (const log of data.logs) {
        await logToDiscordChatLog(`${log.timestamp} 💬 **\`${realNick}\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
      }

      for (const cmd of data.commands) {
        try {
          if (cmd.startsWith(config.botprefix)) await ensureUser(realNick)
          await processUserCommand(realNick.toLowerCase(), cmd);
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

  if (parsed.startsWith('>  Игрок не найден.')) {
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
      const realnameMatch = parsed.match(/^~(.+?) is (\w+)/);
      if (realnameMatch) {
        usernameRaw = realnameMatch[2];
        nickMap.set(`~${realnameMatch[1]}`.toLowerCase(), usernameRaw);
      }
    }

    if (!usernameRaw.startsWith('~') && msgText.startsWith(config.botprefix)) {
      await ensureUser(usernameRaw);
    }

  } else {
    usernameRaw = parsed.split(/\s+/)[0];
    msgText = parsed;
  }

  await handleChat(usernameRaw, msgText, parsed, jsonMsg);
});

bot.once('windowOpen', (window) => {
  const title = window.title?.value?.text?.value || 'Без названия';
  console.log(
    chalk.bold.hex('#FF70C3')(t('other.gui.prefix')) + ' ' +
    chalk.hex('#ffafde')(`${t('other.gui.window_opened')}: ${title}`)
  );

  if (title.toLowerCase().includes('выбор')) {
    const slot = window.slots[21];
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

  const consoleCommands = ['blacklist', 'eco', 'cmd', 'ban', 'unban', 'rape', 'exit', 'info', 'bcode', 'restart'];

  if (consoleCommands.some(cmd => lowered.startsWith(config.botprefix + cmd))) {
    await processUserCommand('CONSOLE', trimmed);
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
      console.log(chalk.hex('#00FF00')(t('other.console.menu.slotclicked', { slot: slot })));
    } catch (err) {
      console.log(chalk.hex('#FF0000')(`${t('other.console.menu.click_error')}: ${err}`));
    }
  } else if (trimmed.startsWith('/')) {
    bot.chat(trimmed);

  } else if (trimmed.startsWith('discord.send ')) {
    const msg = trimmed.slice("discord.send".length).trim();

    if (!msg) {
      console.log(chalk.hex('#7CB6FF')(t('other.console.discord.send_notext')));
      return
    }

    try {
      await discordOutput.send(msg);
      console.log(chalk.hex('#7CB6FF')(t("other.console.discord.sended")));
    } catch (err) {
      console.error(chalk.hex('#7CB6FF')(`${t('other.console.discord.send_error')}: ${err}`));
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

  } else {
    bot.chat(`${trimmed}`);
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