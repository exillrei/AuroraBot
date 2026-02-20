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

const withdrawRequests = new Map();
const activeBlackjackGames = new Map();

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

  await checkUpdate();

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

    if (msg.author.id && !roles.has('Your Role ID')) {
      await discordOutput.send({ embeds: [sendEmbed(`<:accessdenied:1463611412143149280> ${t('discord.accessdenied')}`, ``, { color: 0x5499f4, footer: 'DENIED', fields: [{ name: `${t('discord.noaccess')}`, value: `\`\`\`${content}\`\`\``, inline: true }], timestamp: true })] });
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

const pkgjson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
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

async function userExists(username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT 1 FROM users WHERE nickname = ?', [username], (err, row) => {
      if (err) return reject(err);
      resolve(!!row);
    });
  });
}

async function resolveUserArg(arg) {
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

fs.watchFile('./settings/roles.yml', () => {
  loadRoles();
});

function getRoles() {
  return roles;
}

async function isBlacklisted(username) {
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

async function hasPermission(username, cmd) {
  if (!username || !cmd) return false;

  if (username === 'SYSTEM') return true;

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

  nickname = nickname
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

  nickname = nickname
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

  if (await checkBan(realNick)) return;

  if (await isBlacklisted(realNick)) {
    await bot.chat(`/m ${realNick} ${t('bot.blacklisted')}`);
    return;
  }

  const now = Date.now();
  if (now - lastBotCall < botCooldown) {
    await bot.chat(`/m ${realNick} &c${t('bot.ai_cooldown')}`);
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

async function handleChat(usernameRaw, msgText, parsed, jsonMsg, source) {
  try {
    const username = cleanName(usernameRaw);
    const timestamp = getFormattedTimestamp();

    if (isDuplicateMessage(username, msgText)) return;

    if (/^(❤ )?\[(ɢ|ʟ)\]/i.test(parsed) && msgText.toLowerCase().includes('бот,')) {

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

    const arrowSymbol = '⇨'
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
        await logToDiscordChatLog(`${timestamp} <:chat:1462889419294900299> **\`${usernameRaw}\`**\n\`\`\`\n${msgText}\n\`\`\``);
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

async function checkBan(username) {
  if (username === 'SYSTEM') return false;
  const banInfo = await isBanned(username);
  if (banInfo) {
    const msLeft = banInfo.unbanAt - Date.now();
    const timeLeft = formatDuration(msLeft);
    bot.chat(`/me ${username} ${t('bot.bot_blocked', { timeLeft: timeLeft, reason: banInfo.reason })}`);
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

async function setBalance(username, amount) {
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

function getBotBalance() {
  return new Promise((resolve) => {
    const listener = async (jsonMsg) => {
      const parsed = parseFormattedMessage(jsonMsg?.json || jsonMsg) + '';
      if (parsed.includes('Ваш баланс:')) {
        const match = parsed.match(/\$([\d]{1,3}(?:,\d{3})*|\d+)/);
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

async function processUserCommand(realUsername, message, source = 'mc', originalSender = null, parsed) {
  const isConsole = realUsername === 'SYSTEM';
  const originalCasedUsername = isConsole ? 'SYSTEM' : resolveUsername(realUsername);
  const displayName = source === 'discord' && originalSender ? originalSender : originalCasedUsername;

  if (realUsername === 'Unknown Player') return;

  const bannedRunCommands = [
    '/sphere', '/cyl', '/hcyl', '/walls', '/set', '/faces', '/overlay',
    '/hsphere', '/pyramid', '/hpyramid', '/outline', '/replacenear', '/replace',
    '/removenear', '/frb', '/snow', 'hub'
  ];
  const discordBlockedCommands = ['pay', 'balance', 'feedback', 'code', 'bcode', 'shop', 'casino', 'bj'];
  const alwaysAllowed = ['help', 'info', 'feedback', 'balance', 'pay', 'shop', 'code', 'casino', 'bj'];

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
    await bot.chat(`/m ${displayName} &c${t('bot.blacklisted')}`);
    return;
  }

  if (!alwaysAllowed.includes(cmd) && !isConsole) {
    if (!(await hasPermission(displayName, cmd))) {
      await bot.chat(`/m ${displayName} ${t('bot.cmd.noperm')} &e${config.botprefix}${cmd}!`);
      return;
    }
  }

  if (config.testmode && source == 'mc') {
    const role = await getRole(displayName);
    if (role !== 'owner') {
      await bot.chat(`/m ${displayName} ${t('bot.testmode')}`);
      return;
    }
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

        const detailedList = Object.entries(commandDescriptions)
          .map(([cmd, desc]) => `${config.botprefix}${cmd} » ${desc}`)
          .join('\n');

        await outputToDiscord(detailedList);
      } else {
        const withPrefix = allCommands.map(c => config.botprefix + c);
        await bot.chat(
          `/m ${displayName} ${t('bot.cmd.availablecmds')} &e${withPrefix.join(', ')}`
        );
      }

      break;
    }

    case 'info': {
      const target = parts[1];

      if (!target) {
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
          const roleDisplay = roleData?.display || '&7???';

          await bot.chat(`/m ${displayName} ${t('bot.cmd.info', { displayName, prefix: config.botprefix, uptime: formatted, role: roleDisplay })}`);
        } else {
          await discordOutput.send({
            embeds: [
              sendEmbed(
                `ℹ️ ${t('bot.cmd.info_dc.info')}`, '',
                {
                  color: 0x5499f4,
                  footer: 'INFO',
                  fields: [
                    { name: t('bot.cmd.info_dc.creator'), value: '**exillrei**', inline: true },
                    { name: t('bot.cmd.info_dc.help'), value: `**${config.botprefix}help**`, inline: true },
                    { name: t('bot.cmd.info_dc.uptime'), value: `**${formatted}**`, inline: true },
                    { name: t('bot.cmd.info_dc.connection'), value: `**${ipPort}**`, inline: true },
                    { name: t('bot.cmd.info_dc.online'), value: `**${Object.keys(bot.players).length}**`, inline: true },
                    { name: t('bot.cmd.info_dc.ping'), value: `**${mcPing}/${discordPing}**`, inline: true }
                  ],
                  timestamp: true
                }
              )
            ]
          });
        }
        break;
      }

      let targetUser = null;
      if (target.startsWith(':') && /^\d+$/.test(target.slice(1))) {
        const id = Number(target.slice(1));
        targetUser = await new Promise((resolve, reject) => {
          db.get('SELECT id, nickname, role, balance FROM users WHERE id = ?', [id], (err, row) => err ? reject(err) : resolve(row));
        });
      } else {
        targetUser = await new Promise((resolve, reject) => {
          db.get('SELECT id, nickname, role, balance FROM users WHERE nickname = ?', [target], (err, row) => err ? reject(err) : resolve(row));
        });
      }

      if (!targetUser) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        break;
      }

      const roleData = roles[targetUser.role];
      const roleDisplay = roleData?.display || '???';

      if (source === 'mc') {
        await bot.chat(`/m ${displayName} &f${roleDisplay} &f${targetUser.nickname} &8| &eID: &6${targetUser.id} &8| &2${t('db.balance')}: &6${targetUser.balance.toLocaleString('de-DE')}⛃`);
      } else {
        await discordOutput.send({
          embeds: [
            sendEmbed(
              `ℹ️ ${targetUser.nickname}`,
              null,
              {
                color: 0x5499f4,
                footer: 'INFO',
                fields: [
                  { name: '🆔 ID', value: `\`${targetUser.id}\``, inline: true },
                  { name: `🏷 ${t('db.role')}`, value: `\`${targetUser.role}\``, inline: true },
                  { name: `💰 ${t('db.balance')}`, value: `\`${targetUser.balance}\``, inline: true }
                ],
                timestamp: true
              }
            )
          ]
        });
      }

      break;
    }

    case 'msg': {
      const msgText = parts.slice(1).join(' ').trim();
      if (!msgText) break;

      if (msgText.includes(config.botprefix)) {
        if (source === 'mc') {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}`);
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
          await bot.chat(`/m ${displayName} ${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
        }
        break;
      }

      if (bannedRunCommands.some(b => cmdLower.startsWith(b))) {
        if (source === 'mc') {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.run.blockedcmd')}`);
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
          await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.usage', { prefix: config.botprefix })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.usagedc', { prefix: config.botprefix })}`);
        return;
      }

      if (subcmd === 'info') {
        const list = await getBlacklist();

        if (!list.length) {
          if (source === 'mc')
            await bot.chat(`/m ${displayName} &c${t('bot.cmd.blacklist.empty')}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.empty')}`);
        } else {
          if (source === 'mc')
            await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.list', { list: list.join(', ') })}`);
          else
            await outputToDiscord(`${t('bot.cmd.blacklist.listdc', { list: list.join(', ') })}`);
        }
        break;
      }

      if (!target) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.usage_sub', { prefix: config.botprefix, subcmd })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.usage_subdc', { prefix: config.botprefix, subcmd })}`);
        break;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser || !(await userExists(targetUser))) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const role = await getRole(targetUser);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        if (source === 'mc')
          await bot.chat(`/m ${displayName} &c${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
        else
          await outputToDiscord(`${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
        break;
      }

      if (subcmd === 'add') {
        if (await isBlacklisted(targetUser)) {
          if (source === 'mc')
            await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.already', { user: targetUser })}`);
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
            await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.not_in', { user: targetUser })}`);
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
          await bot.chat(`/m ${displayName} ${t('bot.cmd.ban.usage', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.ban.usagedc', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser || !(await userExists(targetUser))) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const role = await getRole(targetUser);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        await bot.chat(`/m ${displayName} &c${t('bot.cmd.ban.cannot_ban', { role: roleName })}`);
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
          await bot.chat(`/m ${displayName} &c${t('bot.cmd.ban.bad_time')}`);
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
          await bot.chat(`/m${displayName} ${t('bot.cmd.unban.usage', { prefix: config.botprefix })}`);
        else
          await outputToDiscord(`${t('bot.cmd.unban.usagedc', { prefix: config.botprefix })}`);
        return;
      }

      const targetNick = await resolveUserArg(target);
      if (!targetNick) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      const banInfo = await isBanned(targetNick);
      if (!banInfo) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.cmd.unban.not_banned', { user: targetNick })}`);
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
          await bot.chat(`/m ${displayName} ${t('bot.cmd.cmd.usage_mc', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.cmd.usage_discord', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser || !(await userExists(targetUser))) {
        if (source === 'mc') {
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
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
        await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.usage', { prefix: config.botprefix })}`);
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
          await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.no_text')}`);
          return;
        }

        feedbackData[originalCasedUsername] = feedbackText;
        fs.writeFileSync(file, yaml.dump(feedbackData, { indent: 2, lineWidth: -1 }), 'utf-8');

        await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.saved')}`);
      }

      if (subcmd === 'random') {
        const keys = Object.keys(feedbackData);
        if (keys.length === 0) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.empty')}`);
          return;
        }

        const randomUser = keys[Math.floor(Math.random() * keys.length)];
        const feedback = feedbackData[randomUser];

        await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.from', { user: randomUser, text: feedback })}`);
      }

      if (subcmd === 'total') {
        const total = Object.keys(feedbackData).length;

        await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.total', { total })}`);
      }

      if (subcmd === 'info') {
        const targetUser = parts[2];
        const target = targetUser ? targetUser.toLowerCase() : null;

        if (!target) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.info_usage', { prefix: config.botprefix })}`);
          return;
        }

        const feedbackEntry = Object.entries(feedbackData)
          .find(([name]) => name.toLowerCase() === target);

        if (!feedbackEntry) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.not_found', { user: targetUser })}`);
          return;
        }

        const [name, feedbackText] = feedbackEntry;

        await bot.chat(`/m ${displayName} ${t('bot.cmd.feedback.from', { user: name, text: feedbackText })}`);
      }

      break;
    }

    case 'rape': {
      const target = parts[1];

      if (!target) {
        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.rape.usage', { prefix: config.botprefix })}`);
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
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.top_empty')}`);
            return;
          }

          const topPlayers = rows
            .map((r, i) => `&d${i + 1}. &a${r.nickname} &7- &6${r.balance.toLocaleString('de-DE')}⛃`)
            .join(' &8| ');

          await bot.chat(`/m ${username} ${t('bot.cmd.balance.top_list', { list: topPlayers })}`);
        });
        break;
      }

      if (arg && arg.toLowerCase() !== 'withdraw' && arg !== username) {
        const targetUser = await resolveUserArg(arg);
        if (!targetUser || !(await userExists(targetUser))) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.not_found')}`);
          break;
        }

        const targetBalance = await getBalance(targetUser);
        await bot.chat(`/m ${username} ${t('bot.cmd.balance.target', { target: targetUser, balance: targetBalance.toLocaleString('de-DE') })}`);
        break;
      }

      if (arg?.toLowerCase() === 'withdraw') {

        const sub = parts[2]?.toLowerCase();

        if (sub === 'confirm') {
          const targetUser = parts[3];
          if (!targetUser) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_selectuser')}`);
            break;
          }

          const role = await getRole(username);
          if (role !== 'owner') {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_confirmonlyowner')}`);
            break;
          }

          const request = withdrawRequests.get(targetUser);
          if (!request) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_norequest')}`);
            break;
          }

          const amount = request.amount;

          if (amount < config.minwithdraw) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_min', { min: config.minwithdraw })}`);
            break;
          }

          let botBalance;
          try {
            botBalance = await getBotBalance();
          } catch (err) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.errorbotbalance')}`);
            break;
          }

          if (botBalance < amount) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.nobotmoney', { botBalance })}`);
            break;
          }

          await changeBalance(targetUser, -amount);
          bot.chat(`/pay ${targetUser} ${amount}`);

          withdrawRequests.delete(targetUser);

          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.withdraw_confirmed', { amount: amount.toLocaleString('de-DE'), targetUser, username })}`);
          break;
        }

        if (sub === 'decline') {
          const targetUser = parts[3];
          if (!targetUser) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_selectuser')}`);
            break;
          }

          const role = await getRole(username);
          if (role !== 'owner') {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_declinemonlyowner')}`);
            break;
          }

          const request = withdrawRequests.get(targetUser);
          if (!request) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_norequest')}`);
            break;
          }

          withdrawRequests.delete(targetUser);

          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.withdraw_declined', { amount: request.amount.toLocaleString('de-DE'), targetUser, username })}`);
          break;
        }


        const amount = parseInt(parts[2], 10);
        if (isNaN(amount) || amount <= 0) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_invalid')}`);
          break;
        }

        if (amount < config.minwithdraw) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_min', { min: config.minwithdraw })}`);
          break;
        }

        const playerCoins = await getBalance(username);
        if (playerCoins < amount) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_nomoney', { amount: amount.toLocaleString('de-DE') })}`);
          break;
        }

        let botBalance;
        try {
          botBalance = await getBotBalance();
        } catch (err) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.errorbotbalance')}`);
          break;
        }

        if (botBalance < amount) {
          await bot.chat(`/m ${username} ${t('bot.cmd.balance.nobotmoney', { botBalance })}`);
          break;
        }

        if (amount >= config.minwithdrawconfirm) {

          if (withdrawRequests.has(username)) {
            await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_activerequest')}`);
            break;
          }

          withdrawRequests.set(username, {
            amount,
            createdAt: Date.now()
          });

          await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_requestsended', { amount: amount.toLocaleString('de-DE') })}`);
          await outputToDiscord(`${t('bot.cmd.balance.withdraw_notifysendrequest', { username, amount: amount.toLocaleString('de-DE'), prefix: config.botprefix })}`)
          break;
        }

        await changeBalance(username, -amount);
        bot.chat(`/pay ${username} ${amount}`);

        await bot.chat(`/m ${username} ${t('bot.cmd.balance.withdraw_done', { amount: amount.toLocaleString('de-DE') })}`);
        await outputToDiscord(`${t('bot.cmd.balance.withdraw_notifydone', { username, amount: amount.toLocaleString('de-DE') })}`)
        break;
      }

      const balance = await getBalance(username);
      await bot.chat(`/m ${username} ${t('bot.cmd.balance.your', { balance: balance.toLocaleString('de-DE') })}`);
      break;
    }

    case 'eco': {
      const subcmd = parts[1]?.toLowerCase();
      const target = parts[2];
      const amount = parseInt(parts[3], 10);

      if (!['give', 'take', 'set'].includes(subcmd || '') || !target || isNaN(amount)) {
        if (source === 'mc') {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.eco.usage', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`${t('bot.cmd.eco.usagedc', { prefix: config.botprefix })}`);
        }
        return;
      }

      const targetUser = await resolveUserArg(target);

      if (!targetUser || !(await userExists(targetUser))) {
        if (source === 'mc')
          await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        else
          await outputToDiscord(`${t('bot.usernotfounddc', { user: target })}`);
        return;
      }

      if (subcmd === 'give') {
        await changeBalance(targetUser, amount);

        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.give_mc', { username: displayName, target: targetUser, amount: amount.toLocaleString('de-DE') })}`);

        if (source === 'discord')
          await outputToDiscord(`${t('bot.cmd.eco.give_dc', { target: targetUser, amount: amount.toLocaleString('de-DE') })}`);
      }

      if (subcmd === 'take') {
        await changeBalance(targetUser, -amount);

        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.take_mc', { username: displayName, target: targetUser, amount: amount.toLocaleString('de-DE') })}`);

        if (source === 'discord')
          await outputToDiscord(`${t('bot.cmd.eco.take_dc', { target: targetUser, amount: amount.toLocaleString('de-DE') })}`);
      }

      if (subcmd === 'set') {
        await setBalance(targetUser, amount);

        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.set_mc', { username: displayName, target: targetUser, amount: amount.toLocaleString('de-DE') })}`);

        if (source === 'discord')
          await outputToDiscord(`${t('bot.cmd.eco.set_dc', { target: targetUser, amount: amount.toLocaleString('de-DE') })}`);
      }

      break;
    }

    case 'pay': {
      const target = parts[1];
      const amount = parseInt(parts[2], 10);
      const sender = realUsername;

      if (!target || isNaN(amount) || amount <= 0) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.usage', { prefix: config.botprefix })}`);
        return;
      }

      const targetUser = await resolveUserArg(target);
      if (!targetUser || !(await userExists(targetUser))) {
        await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
        return;
      }

      if (targetUser === sender) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.self')}`);
        return;
      }

      const senderBalance = await getBalance(sender);
      if (senderBalance < amount) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.no_money', { balance: senderBalance })}`);
        return;
      }

      await changeBalance(sender, -amount);
      await changeBalance(targetUser, amount);

      await bot.chat(`/me &8[&#00FF00⛃&8] ${t('bot.cmd.pay.success', { username: displayName, target: targetUser, amount: amount.toLocaleString('de-DE') })}`);
      break;
    }

    case 'shop': {
      const subcmd = parts[1]?.toLowerCase();
      const itemId = parts[2]?.toLowerCase();
      const buyer = realUsername.toLowerCase();
      const oneTimeItems = ['rape'];

      if (!shop || !Array.isArray(shop)) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.unavailable')}`);
        return;
      }

      if (!subcmd) {
        const list = shop.map(i => `&e${i.name} &8(&6${i.price.toLocaleString('de-DE')}⛃&8)`).join('&e, ');
        await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.list', { list })}`);
        return;
      }

      if (subcmd === 'buy') {
        if (!itemId) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.usage', { prefix: config.botprefix })}`);
          return;
        }

        const item = shop.find(i => i.id.toLowerCase() === itemId || i.name.toLowerCase() === itemId);
        if (!item) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.not_found', { item: itemId })}`);
          return;
        }

        const itemKey = item.id.toLowerCase();

        if (oneTimeItems.includes(itemKey)) {
          if (!purchases[buyer]) purchases[buyer] = [];
          if (purchases[buyer].includes(itemKey)) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.already_bought', { item: item.name })}`);
            return;
          }
        }

        const bal = getBalance(buyer);
        if (bal < item.price) {
          await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.not_enough', { item: item.name, price: item.price.toLocaleString('de-DE') })}`);
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

        await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.success', { item: item.name, price: item.price.toLocaleString('de-DE') })}`);
      } else {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.invalid_sub', { prefix: config.botprefix })}`);
      }
      break;
    }

    case 'code': {
      const codeName = parts[1]?.toLowerCase();
      const username = realUsername

      if (!codeName) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.code.no_code', { prefix: config.botprefix })}`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.code.not_found', { code: codeName })}`);
        return;
      }

      const alreadyUsed = codeObj.usedBy?.includes(username);
      if (alreadyUsed && (codeObj.perPlayerLimit ?? 1) <= 1) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.code.already_used')}`);
        return;
      }

      if (codeObj.globalLimit && (codeObj.usedTotal || 0) >= codeObj.globalLimit) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.code.limit_reached')}`);
        return;
      }

      if (codeObj.action?.type === 'money') {
        const amount = codeObj.action.amount || 0;
        changeBalance(username, amount);
        await bot.chat(`/m ${displayName} &8[&#00ff00🛈&8] ${t('bot.cmd.code.activated_money', { amount: amount.toLocaleString('de-DE') })}`);
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
        await bot.chat(`/m ${displayName} ${t('bot.cmd.bcode.no_code', { prefix: config.botprefix })}`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/m ${displayName} ${t('bot.cmd.bcode.not_found', { code: codeName })}`);
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
        players = [...seenPlayers].filter(p => p !== bot.username);

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
        lang: t('bot.cmd.config.lang'),
        minwithdraw: t('bot.cmd.config.minwithdraw'),
        mindeposit: t('bot.cmd.config.mindeposit'),
        minbet: t('bot.cmd.config.minbet'),
        minwithdrawconfirm: t('bot.cmd.config.minwithdrawconfirm')
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
      const args = parts.slice(1).map(a => a?.trim()).filter(Boolean);
      const sub = args[0];
      const roles = getRoles();

      if (!sub) {
        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage', { prefix: config.botprefix })}`);
        else await outputToDiscord(t('bot.cmd.role.usagedc', { prefix: config.botprefix }));
        break;
      }

      if (sub === 'add') {
        const roleName = args[1];
        const display = args.slice(2).join(' ');

        if (!roleName || !display) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_add', { prefix: config.botprefix })}`);
          else await outputToDiscord(t('bot.cmd.role.usage_adddc', { prefix: config.botprefix }));
          break;
        }

        if (roles[roleName]) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.exists', { role: roleName })}`);
          else await outputToDiscord(t('bot.cmd.role.existsdc', { role: roleName }));
          break;
        }

        roles[roleName] = { display, cmds: [] };
        saveRoles();

        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.created', { role: roleName })}`);
        else await outputToDiscord(t('bot.cmd.role.createddc', { role: roleName }));
        break;
      }

      if (sub === 'remove') {
        const roleName = args[1];

        if (!roleName || !roles[roleName]) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.notfound', { role: roleName })}`);
          else await outputToDiscord(t('bot.cmd.role.notfounddc', { role: roleName }));
          break;
        }

        delete roles[roleName];
        saveRoles();

        db.run('UPDATE users SET role = "user" WHERE role = ?', [roleName]);

        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.removed', { role: roleName })}`);
        else await outputToDiscord(t('bot.cmd.role.removeddc', { role: roleName }));
        break;
      }

      if (sub === 'set') {
        const targetArg = args[1];
        const roleName = args[2];

        if (!targetArg || !roles[roleName]) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_set', { prefix: config.botprefix })}`);
          else await outputToDiscord(t('bot.cmd.role.usage_setdc', { prefix: config.botprefix }));
          break;
        }

        const nickname = await resolveUserArg(targetArg);
        if (!nickname) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.usernotfounddc', { user: targetArg })}`);
          else await outputToDiscord(t('bot.usernotfounddcdc', { user: targetArg }));
          break;
        }

        db.run('UPDATE users SET role = ? WHERE nickname = ?', [roleName, nickname]);

        const roleData = roles[roleName];
        const roleDisplay = roleData?.display || '&7???';

        await bot.chat(`/me &8[&#439FFF🛡&8] ${t('bot.cmd.role.assigned', { by: displayName, user: nickname, role: roleDisplay })}`);
        if (source === 'discord') await outputToDiscord(t('bot.cmd.role.assigneddc', { user: nickname, role: roleName }));
        break;
      }

      if (sub === 'cmd') {
        const action = args[1];
        const roleName = args[2];
        const command = args[3]?.replace(config.botprefix, '');

        if (!['add', 'remove'].includes(action) || !roles[roleName] || !command) {
          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_cmd', { prefix: config.botprefix })}`);
          else await outputToDiscord(t('bot.cmd.role.usage_cmddc', { prefix: config.botprefix }));
          break;
        }

        const cmds = roles[roleName].cmds ?? [];

        if (action === 'add') {
          if (!cmds.includes(command)) cmds.push(command);
          roles[roleName].cmds = cmds;
          saveRoles();

          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.cmd_added', { command, role: roleName })}`);
          else await outputToDiscord(t('bot.cmd.role.cmd_addeddc', { command, role: roleName }));
          break;
        }

        if (action === 'remove') {
          roles[roleName].cmds = cmds.filter(c => c !== command);
          saveRoles();

          if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.cmd_removed', { command, role: roleName })}`);
          else await outputToDiscord(t('bot.cmd.role.cmd_removeddc', { command, role: roleName }));
          break;
        }
      }

      if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.unknown_sub')}`);
      else await outputToDiscord(t('bot.cmd.role.unknown_subdc'));
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

    case 'casino': {
      const args = message.trim().split(/\s+/).slice(1);
      const sub = args[0];

      if (sub !== 'bet') {
        bot.chat(`/m ${displayName} ${t('bot.cmd.casino.usage', { prefix: config.botprefix })}`);
        break;
      }

      const bet = parseInt(args[1]);
      if (!bet || bet <= 0) { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.zerobet')}`); break; }
      if (bet < config.minbet) { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.minbet')}`); break; }

      const balance = await getBalance(displayName);
      if (bet > balance) { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.nomoney')}`); break; }

      const roll = Math.random() * 100;
      let multiplier = 0;
      if (roll < 45) multiplier = 0;
      else if (roll < 75) multiplier = 1;
      else if (roll < 90) multiplier = 2;
      else if (roll < 96) multiplier = 3;
      else if (roll < 99) multiplier = 4;
      else multiplier = 5;

      const profit = bet * multiplier - bet;
      const newBalance = await changeBalance(displayName, profit);
      const formattedProfit = profit.toLocaleString('de-DE');

      if (multiplier === 0) {
        bot.chat(`/me &8[&#FFC022✨&8] ${t('bot.cmd.casino.defeat', { displayName, bet: bet.toLocaleString('de-DE'), newBalance: newBalance.toLocaleString('de-DE') })}`);
      } else if (multiplier === 1) {
        bot.chat(`/me &8[&#FFC022✨&8] ${t('bot.cmd.casino.return', { displayName, newBalance: newBalance.toLocaleString('de-DE') })}`);
      } else {
        bot.chat(`/me &8[&#FFC022✨&8] ${t('bot.cmd.casino.win', { displayName, multiplier, profit: formattedProfit, newBalance: newBalance.toLocaleString('de-DE') })}`);
      }

      break;
    }

    case 'bj': {
      const args = message.trim().split(/\s+/).slice(1);
      const bjSub = args[0]?.toLowerCase();
      const bet = parseInt(args[1]);

      function drawCard() {
        const cards = [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 11];
        return cards[Math.floor(Math.random() * cards.length)];
      }

      function calculateTotal(hand) {
        let total = hand.reduce((a, b) => a + b, 0);
        let aces = hand.filter(c => c === 11).length;
        while (total > 21 && aces > 0) { total -= 10; aces--; }
        return total;
      }

      if (bjSub === 'start') {
        if (!bet || bet <= 0) { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.zerobet')}`); break; }
        const balance = await getBalance(displayName);
        if (bet > balance) { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.nomoney')}`); break; }

        await changeBalance(displayName, -bet);
        const playerHand = [drawCard(), drawCard()];
        const dealerHand = [drawCard(), drawCard()];

        activeBlackjackGames.set(displayName, { bet, playerHand, dealerHand, status: 'playing' });

        const total = calculateTotal(playerHand);
        bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.yourcards')} &b${playerHand.join(', ')} &8(&9=${total}&8) &8| ${t('bot.cmd.casino.blackjack.dealercard')} &b${dealerHand[0]} &8| ${t('bot.cmd.casino.blackjack.usehitorstand', { prefix: config.botprefix })}`);
        break;
      }

      if (bjSub === 'hit') {
        const game = activeBlackjackGames.get(displayName);
        if (!game || game.status !== 'playing') { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.noactivegame')}`); break; }

        game.playerHand.push(drawCard());
        const total = calculateTotal(game.playerHand);

        if (total > 21) {
          game.status = 'lost';
          bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.bust')} &6${game.bet.toLocaleString('de-DE')}⛃`);
          bot.chat(`/me &8[&e🃏&8] ${t('bot.cmd.casino.blackjack.defeat_broadcast', { user: displayName, bet: game.bet.toLocaleString('de-DE') })}`);
          activeBlackjackGames.delete(displayName);
        } else {
          bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.yourcards')} &b${game.playerHand.join(', ')} &8(&9=${total}&8) &8| ${t('bot.cmd.casino.blackjack.usehitorstand', { prefix: config.botprefix })}`);
        }
        break;
      }

      if (bjSub === 'stand') {
        const game = activeBlackjackGames.get(displayName);
        if (!game || game.status !== 'playing') { bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.noactivegame')}`); break; }

        function dealerPlay(hand) {
          while (calculateTotal(hand) < 17) { hand.push(drawCard()); }
          return hand;
        }

        const dealerHand = dealerPlay(game.dealerHand);
        const playerTotal = calculateTotal(game.playerHand);
        const dealerTotal = calculateTotal(dealerHand);
        let resultText = '';
        const winbet = game.bet * 2;
        const formattedWinBet = winbet.toLocaleString('de-DE');

        if (dealerTotal > 21 || playerTotal > dealerTotal) {
          resultText = `${t('bot.cmd.casino.blackjack.win')} &6${formattedWinBet}⛃`;
          await changeBalance(displayName, winbet);
          bot.chat(`/me &8[&e🃏&8] ${t('bot.cmd.casino.blackjack.win_broadcast', { user: displayName, bet: formattedWinBet })}`);
        } else if (playerTotal === dealerTotal) {
          resultText = `${t('bot.cmd.casino.blackjack.tie')} &8(&6${game.bet.toLocaleString('de-DE')}⛃&8)`;
          await changeBalance(displayName, game.bet);
          bot.chat(`/me &8[&e🃏&8] ${t('bot.cmd.casino.blackjack.tie_broadcast', { user: displayName })}`);
        } else {
          resultText = `${t('bot.cmd.casino.blackjack.defeat')} &6${game.bet.toLocaleString('de-DE')}⛃`;
          bot.chat(`/me &8[&e🃏&8] ${t('bot.cmd.casino.blackjack.defeat_broadcast', { user: displayName, bet: game.bet.toLocaleString('de-DE') })}`);
        }

        bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.dealer')} &b${dealerHand.join(', ')} &8(&9=${dealerTotal}&8) &8| ${t('bot.cmd.casino.blackjack.yourcards')} &b${game.playerHand.join(', ')} &8(&9=${playerTotal}&8) &8| ${resultText}`);
        activeBlackjackGames.delete(displayName);
        break;
      }

      bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.usage', { prefix: config.botprefix })}`);
      break;
    }

    default: {
      if (source === 'mc') {
        await bot.chat(`/m ${displayName} &c${t('bot.unknowncmd', { cmd: config.botprefix + cmd })}`);
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
  const msg = `${timestamp}\n<:join:1462889409421639760> ${t('other.player.join', { username: player.username })}`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

bot.on('playerLeft', (player) => {
  const timestamp = getFormattedTimestamp();
  if (!player?.username) return;
  seenPlayers.delete(player.username)
  const msg = `${timestamp}\n<:leave:1462889414676975780> ${t('other.player.left', { username: player.username })}`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

const pendingRealnames = new Map();

bot.on('message', async (jsonMsg) => {
  const parsed = (parseFormattedMessage(jsonMsg?.unsigned?.json || jsonMsg?.json || jsonMsg) + '').replace(/§[xrl]/gi, '');
  const colored = (parseColoredText(jsonMsg?.unsigned?.json || jsonMsg?.json || jsonMsg) + '').replace(/§[xrl]/gi, '');
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

  const coinConvertRegex = /\$([\d]{1,3}(?:,\d{3})*) получено от игрока (~?\w+)/;
  const moneymatch = parsed.match(coinConvertRegex);

  if (moneymatch) {
    const money = parseInt(moneymatch[1].replace(/,/g, ''), 10);
    let username = moneymatch[2].trim();
    if (money === 0) return;

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

  if (pendingDiscordRun) {
    const cleanText = parseFormattedMessage(jsonMsg.json || jsonMsg);
    if (cleanText?.trim()) collectedRunOutput.push(cleanText.trim());
    if (runTimeout) clearTimeout(runTimeout);
    runTimeout = setTimeout(async () => {
      if (collectedRunOutput.length > 0) {
        const combined = collectedRunOutput.join('\n');
        if (pendingDiscordRun.source === 'discord')
          await outputToDiscord(`${combined}`);
      } else if (pendingDiscordRun?.source === 'discord') {
        await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.cmd.run.executing')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `${t('bot.cmd.run.nomsg', { cmd: pendingDiscordRun.command })}`, inline: true }], timestamp: true })] });
      }
      pendingDiscordRun = null;
      collectedRunOutput = [];
    }, 500);
  }

  const realnameMatch = parsed.match(/^~(.+?) is (\w+)/);
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
        await logToDiscordChatLog(`${log.timestamp} <:chat:1462889419294900299> **\`${realNick}\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
      }

      for (const cmd of data.commands) {
        try {
          await ensureUser(realNick);
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
          await logToDiscordChatLog(`${log.timestamp} <:chat:1462889419294900299> **\`Unknown Player\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
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

    await handleChat(usernameRaw, msgText, parsed, jsonMsg, 'mc');

  } else {
    usernameRaw = parsed.split(/\s+/)[0];
    msgText = parsed;
    await handleChat(usernameRaw, msgText, parsed, jsonMsg, 'other');
  }
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

  const consoleCommands = ['blacklist', 'eco', 'cmd', 'ban', 'unban', 'rape', 'exit', 'info', 'bcode', 'restart', 'role'];

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