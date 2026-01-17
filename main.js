import 'dotenv/config';
import mineflayer from 'mineflayer';
import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import { Client, GatewayIntentBits, REST, EmbedBuilder } from 'discord.js';
import { exec } from "child_process";
import chalk from "chalk";
import yaml from 'js-yaml';
import path from 'path';
import chokidar from 'chokidar';

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
    languages[config.LANG_DIR]
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

const discordRolesMap = new Map();
const discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
let discordOutput = null;
let pendingDiscordRun = null;
let discordLogOutput;
const recentMessages = new Set();

const ownerUsername = (username) => group.owners.includes(username.toLowerCase());
let groups = {};
const startTime = Date.now();
let blacklist = [];
let lastBotCall = 0;
const botCooldown = 30000;
let bannedUsers = {};
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
let economy = {};
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
    await outputToDiscord(`\`\`\`\nUncaught Exception:\n${err.stack || err.message}\n\`\`\``);
  } catch (e) {
    console.error(chalk.hex('#FF7C7C')(e));
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[unhandledRejection]', reason);

  try {
    await outputToDiscord(`\`\`\`\nUnhandled Rejection:\n${reason.stack || reason}\n\`\`\``);
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
  if (!guild) return console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')(t('discord.server_notfound'))
  );

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
    const startType = process.env.pm_id !== undefined ? "PM2" : "Обычный";
    const ip = bot._client?.socket?.remoteAddress || bot.options?.host || 'Не указан';
    const port = bot._client?.socket?.remotePort || bot.options?.port || 'Не указан';
    const ipPort = `${ip}:${port}`;

    if (discordOutput) {
      const embed = {
        color: 0x00ff00,
        title: t('discord.bot_online'),
        fields: [
          { name: t('discord.fields.nickname'), value: `\`${bot.username}\``, inline: true },
          { name: t('discord.fields.start_type'), value: `\`${startType}\``, inline: true },
          { name: t('discord.fields.ip'), value: `\`${ipPort}\``, inline: true },
          { name: t('discord.fields.bot_prefix'), value: `\`${config.botprefix}\``, inline: true },
        ],
        timestamp: new Date(),
      };

      await discordOutput.send({ embeds: [embed] });
    }
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

  if (content.startsWith(config.botprefix)) {
    try {
      const guildMember = await msg.guild.members.fetch(msg.author.id);
      const roles = new Set(guildMember.roles.cache.map(role => role.name));

      discordRolesMap.set(msg.member.displayName, roles);

      await processUserCommand('CONSOLE', content, 'discord', msg.member.displayName);
    } catch (err) {
      console.error(
        chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
        chalk.hex('#FF7C7C')(`${t('discord.command_processing_error')}: ${err}`)
      );
      await msg.reply(`\`\`\`\n${t('discord.msg_command_processing_error')}\n\`\`\``);
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

    await discordOutput.send(cleanMessage);
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
    await discordLogOutput.send(`${message}`);
  } catch (err) {
    console.error(
      chalk.bold.hex('#7CB6FF')('[Discord ChatLog]') + ' ' +
      chalk.hex('#FF7C7C')(`${t('discord.log_error')}: ${err}`)
    );
  }
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
      console.error('[AI Ошибка]', errorMsg);
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim();
    text = limitCharsByWords(text, 240);

    return text;

  } catch (err) {
    const errorText = (err.message || String(err)).slice(0, 80);
    bot.chat(`/me ${t('bot.ai_unavailable')} &8(&6${errorText}&8)`);
    console.error('[AI Ошибка]', err);
  }
}

function loadGroups() {
  try {
    const file = fs.readFileSync('./settings/groups.yml', 'utf8');
    groups = yaml.load(file) || {};
    console.log(
      chalk.bold.hex('#17c717')(t('bot.groups_prefix')) + ' ' +
      chalk.hex('#7DFF7C')(t('bot.groups_loaded'))
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#17c717')(t('bot.groups_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.errorload')}: ${err}`)
    );
    groups = {};
  }
}
loadGroups();

fs.watchFile('./settings/groups.yml', () => {
  console.log(
    chalk.bold.hex('#17c717')(t('bot.groups_prefix')) + ' ' +
    chalk.hex('#FFEA48')(`${t('bot.update')}`)
  );
  loadGroups();
});

function loadBlacklist() {
  try {
    const file = fs.readFileSync('./settings/blacklist.yml', 'utf8');
    blacklist = yaml.load(file) || [];
    if (!Array.isArray(blacklist)) blacklist = [];
  } catch (err) {
    console.error(
      chalk.bold.hex('#17c717')(t('bot.blacklist_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.errorload')}: ${err}`)
    );
    blacklist = [];
  }
}
function saveBlacklist() {
  try {
    fs.writeFileSync('./settings/blacklist.yml', yaml.dump(blacklist, { indent: 2, lineWidth: -1 }), 'utf8');
    console.log(
      chalk.bold.hex('#17c717')(t('bot.blacklist_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.blacklist_saved')}`)
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#17c717')(t('bot.blacklist_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(`${t('bot.blacklist_saveerror')}: ${err}`)
    );
  }
}
loadBlacklist();

fs.watchFile('./settings/blacklist.yml', () => {
  console.log(
    chalk.bold.hex('#17c717')(t('bot.blacklist_prefix')) + ' ' +
    chalk.hex('#FFEA48')(`${t('bot.update')}`)
  );
  loadBlacklist();
});

function isBlacklisted(username) {
  return blacklist.includes(username.toLowerCase());
}

function addToBlacklist(username) {
  if (!blacklist.includes(username.toLowerCase())) {
    blacklist.push(username.toLowerCase());
  }
}

function removeFromBlacklist(username) {
  const index = blacklist.indexOf(username.toLowerCase());
  if (index !== -1) {
    blacklist.splice(index, 1);
  }
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

function getRole(username) {

  if (username === 'CONSOLE') return 'owner';

  const roles = discordRolesMap.get(username);
  if (roles) {
    if (roles.has('Aurora Admin')) return 'owner';
  }

  if (groups.roles && groups.roles[username]) return groups.roles[username];

  return 'user';
}

function hasPermission(username, command) {
  if (username === 'CONSOLE') return true;

  const discordRoles = discordRolesMap.get(username);
  if (discordRoles && discordRoles.has('Aurora Admin')) return true;

  const role = getRole(username);
  if (role === 'owner') return true;
  if (role === 'moder' && ['run', 'msg', 'ban', 'unban', 'blacklist'].includes(command)) {
    return true;
  }

  const user = username.toLowerCase();
  return userPerms[user]?.includes(command) || false;
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

let userPerms = {};

function loadUserPerms() {
  try {
    const file = fs.readFileSync('./settings/user_perms.yml', 'utf8');
    userPerms = yaml.load(file) || {};
  } catch {
    userPerms = {};
  }
}
function saveUserPerms() {
  fs.writeFileSync('./settings/user_perms.yml', yaml.dump(userPerms, { indent: 2, lineWidth: -1 }), 'utf8');
}
loadUserPerms();

function grantPermission(username, command) {
  const user = username.toLowerCase();
  if (!userPerms[user]) userPerms[user] = [];
  if (!userPerms[user].includes(command)) {
    userPerms[user].push(command);
    saveUserPerms();
  }
}

function revokePermission(username, command) {
  const user = username.toLowerCase();
  if (!userPerms[user]) return;
  userPerms[user] = userPerms[user].filter(cmd => cmd !== command);
  if (userPerms[user].length === 0) delete userPerms[user];
  saveUserPerms();
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
    saveEconomy();
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswer')} &e${reward}⛃!`);
  } else {
    bot.chat(`/me &8[&a❓&8] &e${username} ${t('bot.chatgame_correctanswererror')}`);
  }
  currentGame = null;
}

async function processAI(realNick, msgText, source = 'mc') {

  if (checkBan(realNick.toLowerCase(), realNick)) return;

  if (isBlacklisted(realNick.toLowerCase())) {
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
        await outputToDiscord(`\`\`\`\n[WARN] ${t('bot.suspiciousactivity')}:\n${parsed}\n\`\`\``);
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
        await logToDiscordChatLog(`${timestamp} :speech_balloon: **\`${usernameRaw}\`**\n\`\`\`\n${msgText}\n\`\`\``);
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
    await bot.chat(`!&6${originalCasedUsername}, &f${chunk}`);
    remaining = remaining.slice(chunk.length).trim();
    await new Promise(r => setTimeout(r, 3000));
  }
}

function loadBan() {
  try {
    const file = fs.readFileSync('./settings/banned.yml', 'utf8');
    bannedUsers = yaml.load(file) || {};
  } catch {
    bannedUsers = {};
  }
}
function saveBan() {
  fs.writeFileSync('./settings/banned.yml', yaml.dump(bannedUsers, { indent: 2, lineWidth: -1 }), 'utf8');
}
loadBan();

setInterval(() => {
  let changed = false;

  for (const [username, { unbanAt }] of Object.entries(bannedUsers)) {
    if (Date.now() > unbanAt) {
      delete bannedUsers[username];
      changed = true;
      console.log(
        chalk.bold.hex('#AFFF48')(t('bot.ban_prefix')) + ' ' +
        chalk.hex('#a1a1a1')(t('bot.ban_player')) + ' ' +
        chalk.hex('#ffa53e')(`${username}`) + ' ' +
        chalk.hex('#a1a1a1')(t('bot.ban_unbanned'))
      );
    }
  }

  if (changed) saveBan();
}, 10 * 1000);

function banUser(username, durationMs, reason) {
  const unbanAt = Date.now() + durationMs;
  bannedUsers[username.toLowerCase()] = { unbanAt, reason };
  saveBan();
}

function unbanUser(username) {
  delete bannedUsers[username.toLowerCase()];
  saveBan();
}

function isBanned(username) {
  const entry = bannedUsers[username.toLowerCase()];
  if (!entry) return false;
  if (Date.now() > entry.unbanAt) {
    unbanUser(username);
    return false;
  }
  return true;
}

function checkBan(username, originalCasedUsername) {
  if (isBanned(username)) {
    const { unbanAt, reason } = bannedUsers[username.toLowerCase()];
    const msLeft = unbanAt - Date.now();
    const timeLeft = formatDuration(msLeft);
    bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.bot_blocked', { username: originalCasedUsername, timeLeft: timeLeft, reason: reason })}`);
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
  if (days) parts.push(`${days}д`);
  if (hours) parts.push(`${hours}ч`);
  if (minutes) parts.push(`${minutes}м`);
  if (seconds) parts.push(`${seconds}с`);

  return parts.join(' ');
}

function loadEconomy() {
  try {
    const file = fs.readFileSync('./settings/economy.yml', 'utf8');
    economy = yaml.load(file) || {};
  } catch (err) {
    console.warn(
      chalk.bold.hex('#ff5100')(t('bot.economy_prefix')) + ' ' +
      chalk.hex('#FF7C7C')(t('bot.economy_nofile'))
    );
    economy = {};
    saveEconomy();
  }
}
function saveEconomy() {
  fs.writeFileSync('./settings/economy.yml', yaml.dump(economy, { indent: 2, lineWidth: -1 }), 'utf8');
  console.log(
    chalk.bold.hex('#ff5100')(t('bot.economy_prefix')) + ' ' +
    chalk.hex('#7DFF7C')(t('bot.economy_saved'))
  );
}
loadEconomy();

function getBalance(username) {
  if (!economy[username]) economy[username] = 0;
  return economy[username];
}

function changeBalance(username, amount) {
  if (!economy[username]) economy[username] = 0;
  economy[username] += amount;
  if (economy[username] < 0) economy[username] = 0;
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
  const resolvedUsername = resolveUsername(realUsername);
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
    await outputToDiscord(`\`\`\`\n${displayName}, команда ${config.botprefix}${cmd} недоступна через Discord.\n\`\`\``);
    return;
  }

  if (checkBan(realUsername.toLowerCase(), resolvedUsername)) return;

  if (isBlacklisted(realUsername)) {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.blacklisted')}`);
    return;
  }

  if (!alwaysAllowed.includes(cmd) && !isConsole) {
    if (!hasPermission(realUsername, cmd)) {
      await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.noperm')} &e${config.botprefix}${cmd}!`);
      return;
    }
  }

  if (config.testmode && realUsername.toLowerCase() !== ownerUsername.toLowerCase() && source == 'mc') {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.testmode')}`);
    return;
  }

  switch (cmd) {
    case 'help': {
      const effectiveUsername = source === 'discord' ? originalSender : realUsername;
      const role = getRole(effectiveUsername);

      const commandDescriptions = t('bot.cmd.descriptions') || {};
      const commandsList = Object.keys(commandDescriptions);

      if (source === 'discord') {
        const detailedList = commandsList
          .map(cmd => `${config.botprefix}${cmd} » ${commandDescriptions[cmd] || 'Нет описания.'}`)
          .join('\n');

        await outputToDiscord(`\`\`\`\n${detailedList}\n\`\`\``);
      } else {
        const commandsByRole = {
          owner: ['help', 'msg', 'run', 'exit', 'info', 'blacklist', 'ban', 'unban', 'cmd',
            'feedback', 'balance', 'shop', 'pay', 'eco', 'code', 'restart', 'bcode'],
          moder: ['help', 'msg', 'run', 'info', 'ban', 'unban', 'blacklist',
            'feedback', 'balance', 'shop', 'pay', 'code'],
          user: ['help', 'info', 'feedback', 'balance', 'shop', 'pay', 'code']
        };

        const baseCommands = commandsByRole[role] || [];
        const extraPerms = userPerms[effectiveUsername.toLowerCase()] || [];
        const all = [...new Set([...baseCommands, ...extraPerms])];

        const withPrefix = all.map(c => config.botprefix + c);
        await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &aтвои доступные команды: &e${withPrefix.join(', ')}`);
      }

      break;
    }

    case 'info': {
      const uptime = Date.now() - startTime;
      const formatted = formatUptime(uptime);
      if (source === 'mc') {
        await bot.chat(`/me &8[&e✦&8] ${t('bot.cmd.info', { displayName: displayName, prefix: config.botprefix, uptime: formatted })}`);
      } else {
        await outputToDiscord(`\`\`\`\n${t('bot.cmd.info_dc', { prefix: config.botprefix, uptime: formatted })}\n\`\`\``);
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
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}\n\`\`\``);
        }
        break;
      }

      if (config.msg_hidename) {
        await bot.chat(`!${msgText}`);
      } else {
        await bot.chat(`!${t('bot.cmd.msg.from')} &a${displayName}: ${msgText}`);
      }

      if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.msg.dcsubmitted')}\n\`\`\``);
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
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}\n\`\`\``);
        }
        break;
      }

      if (bannedRunCommands.some(b => cmdLower.startsWith(b))) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.run.blockedcmd')}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.run.blockedcmd')}\n\`\`\``);
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
            await outputToDiscord(`\`\`\`\n${combined}\n\`\`\``);
          }
        } else {
          if (pendingDiscordRun?.source === 'discord') {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.run.nomsg', { cmd: pendingDiscordRun.command })}\n\`\`\``);
          }
        }
        pendingDiscordRun = null;
        collectedRunOutput = [];
      }, 500);

      break;
    }

    case 'exit': {
      if (source === 'mc') await bot.chat(`/me &8[&#FF0000⏻&8] ${t('bot.cmd.exit.exitbot')}`);
      if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.exit.exitbot_dc')}\n\`\`\``);
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
        if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.restart.restarting_dc')}\n\`\`\``);
        console.log(chalk.hex('#61EFFF')(`${(t('bot.cmd.restart_logconsole'))}`));

        exec(`pm2 restart ${process.env.pm_id}`, (err, stdout, stderr) => {
          if (err) console.error(chalk.hex('#FF7C7C')(`${t('bot.cmd.restart.error')}: ${err}`));
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
          process.exit(0);
        });
      } else {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] ${t('bot.cmd_restart.launchtype')}`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.restart.launchtype_dc')}\n\`\`\``);
      }
      break;
    }

    case 'blacklist': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];

      if (!['add', 'remove', 'info'].includes(subcmd || '')) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.blacklist.usage', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.usagedc', { prefix: config.botprefix })}\n\`\`\``);
        }
        return;
      }

      if (subcmd === 'info') {
        if (!blacklist.length) {
          if (source === 'mc') {
            await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &c${t('bot.cmd.blacklist.empty')}`);
          } else {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.empty')}\n\`\`\``);
          }
        } else {
          if (source === 'mc') {
            await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &a${t('bot.cmd.blacklist.list', { list: blacklist.join(', ') })}`);
          } else {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.list', { list: blacklist.join(', ') })}\n\`\`\``);
          }
        }
        break;
      }

      if (!targetUser) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.blacklist.usage_sub', { prefix: config.botprefix, subcmd })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.usage_sub', { prefix: config.botprefix, subcmd })}\n\`\`\``);
        }
        break;
      }

      const target = targetUser.toLowerCase();
      const role = getRole(target);

      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}\n\`\`\``);
        }
        break;
      }

      if (subcmd === 'add') {
        if (isBlacklisted(target)) {
          if (source === 'mc') {
            await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.already', { user: targetUser })}`);
          } else {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.already', { user: targetUser })}\n\`\`\``);
          }
        } else {
          addToBlacklist(target);
          await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.blacklist.added_mc', { by: displayName, user: targetUser })}`);
          if (source === 'discord') {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.added_dc', { user: targetUser })}\n\`\`\``);
          }
          saveBlacklist();
        }
      }

      if (subcmd === 'remove') {
        if (!isBlacklisted(target)) {
          if (source === 'mc') {
            await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.blacklist.not_in', { user: targetUser })}`);
          } else {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.not_in', { user: targetUser })}\n\`\`\``);
          }
        } else {
          removeFromBlacklist(target);
          await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.blacklist.removed_mc', { by: displayName, user: targetUser })}`);
          if (source === 'discord') {
            await outputToDiscord(`\`\`\`\n${t('bot.cmd.blacklist.removed_dc', { user: targetUser })}\n\`\`\``);
          }
          saveBlacklist();
        }
      }

      break;
    }

    case 'ban': {
      const targetUser = parts[1];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const timeStr = parts[2];
      const reason = parts.slice(3).join(' ') || 'Без причины';

      if (!target || !timeStr || !/^\d+[smhd]$/.test(timeStr)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.ban.usage', { prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.ban.usagedc', { prefix: config.botprefix })}\n\`\`\``);
        }
        return;
      }

      const role = getRole(target);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        const roleName = role === 'owner' ? 'владельца' : 'модера';
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.ban.cannot_ban', { role: roleName })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.ban.cannot_ban', { role: roleName })}\n\`\`\``);
        }
        return;
      }

      const unit = timeStr.slice(-1);
      const value = parseInt(timeStr.slice(0, -1), 10);
      const ms =
        unit === 's' ? value * 1000 :
          unit === 'm' ? value * 60 * 1000 :
            unit === 'h' ? value * 60 * 60 * 1000 :
              unit === 'd' ? value * 24 * 60 * 60 * 1000 : 0;

      if (!ms) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.ban.bad_time')}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.ban.bad_time')}\n\`\`\``);
        }
        return;
      }

      banUser(target, ms, reason);

      await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.ban.success_mc', { by: displayName, user: targetUser, time: timeStr, reason })}`);

      if (source === 'discord') {
        await outputToDiscord(`\`\`\`\n${t('bot.cmd.ban.success_dc', { user: targetUser, time: timeStr, reason })}\n\`\`\``);
      }

      break;
    }

    case 'unban': {
      const targetUser = parts[1];
      const target = targetUser ? targetUser.toLowerCase() : null;

      if (!target) {
        if (source === 'mc')
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, ${t('bot.cmd.unban.usage', { prefix: config.botprefix })}`);
        else
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.unban.usagedc', { prefix: config.botprefix })}\`\`\``);
        return;
      }

      if (!bannedUsers[target]) {
        if (source === 'mc')
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.cmd.unban.not_banned', { user: targetUser })}`);
        else
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.unban.not_banned', { user: targetUser })}\`\`\``);
        return;
      }

      unbanUser(target);

      await bot.chat(`/me &8[&#00ff00🛈&8] ${t('bot.cmd.unban.success_mc', { by: displayName, user: targetUser })}`);
      if (source === 'discord')
        await outputToDiscord(`\`\`\`\n${t('bot.cmd.unban.success_dc', { user: targetUser })}\`\`\``);

      break;
    }

    case 'cmd': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const targetCommand = parts[3]?.toLowerCase().replace(config.botprefix, '');

      if (!['give', 'take'].includes(subcmd || '') || !target || !targetCommand) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&e🛈&8] &c${t('bot.cmd.cmd.usage_mc', { username: displayName, prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.cmd.usage_discord', { prefix: config.botprefix })}\n\`\`\``);
        }
        return;
      }

      if (subcmd === 'give') {
        grantPermission(target, targetCommand);

        await bot.chat(`/me &8[&#00ff00🛈&8] &a${t('bot.cmd.cmd.give_mc', { by: displayName, user: targetUser, command: targetCommand })}`);

        if (source === 'discord') {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.cmd.give_discord', { user: targetUser, command: targetCommand })}\n\`\`\``);
        }
      } else {
        revokePermission(target, targetCommand);

        await bot.chat(`/me &8[&#00ff00🛈&8] &a${t('bot.cmd.cmd.take_mc', { by: displayName, user: targetUser, command: targetCommand })}`);

        if (source === 'discord') {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.cmd.take_discord', { user: targetUser, command: targetCommand })}\n\`\`\``);
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
        if (source === 'mc') await outputToDiscord(`\`\`\`\n${t('bot.cmd.rape.usagedc', { prefix: config.botprefix })}\n\`\`\``);
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
        await outputToDiscord(`\`\`\`\n${t('bot.cmd.rape.infected_dc', { disease: randomDisease, user: target })}\n\`\`\``);
      }

      break;
    }

    case 'balance': {
      const arg = parts[1]?.toLowerCase();
      const username = realUsername.toLowerCase();

      if (arg === 'top') {
        const entries = Object.entries(economy);
        if (!entries.length) {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.top_empty')}`);
          break;
        }
        const topPlayers = entries
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([user, bal], i) => `&d${i + 1}. &a${user} &7- &6${bal}⛃`)
          .join(' &8| ');
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.top_list', { list: topPlayers })}`);
        break;
      }

      if (arg && arg !== username) {
        const targetBalance = economy[arg];
        if (targetBalance != null) {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.target', { username: displayName, target: arg, balance: targetBalance })}`);
        } else {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.not_found', { username: displayName })}`);
        }
        break;
      }

      const balance = economy[username] ?? 0;
      await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.your', { username: displayName, balance })}`);
      break;
    }

    case 'eco': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const amount = parseInt(parts[3], 10);

      if (!['give', 'take'].includes(subcmd || '') || !targetUser || isNaN(amount)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.usage', { username: displayName, prefix: config.botprefix })}`);
        } else {
          await outputToDiscord(`\`\`\`\n${t('bot.cmd.eco.usagedc', { prefix: config.botprefix })}\n\`\`\``);
        }
        return;
      }

      if (subcmd === 'give') {
        changeBalance(target, amount);
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.give_mc', { username: displayName, target: targetUser, amount })}`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.eco.give_dc', { target: targetUser, amount })}\n\`\`\``);
      } else {
        changeBalance(target, -amount);
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.eco.take_mc', { username: displayName, target: targetUser, amount })}`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\n${t('bot.cmd.eco.take_dc', { target: targetUser, amount })}\n\`\`\``);
      }

      saveEconomy();
      break;
    }

    case 'pay': {
      const targetUser = parts[1];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const amount = parseInt(parts[2], 10);
      const sender = realUsername.toLowerCase();

      if (!target || isNaN(amount) || amount <= 0) {
        await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.pay.usage', { prefix: config.botprefix })}`);
        return;
      }

      if (target === sender) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.pay.self', { username: displayName })}`);
        return;
      }

      const senderBalance = getBalance(sender);
      if (senderBalance < amount) {
        await bot.chat(`/me &8[&#FF0000⛃&8] ${t('bot.cmd.pay.no_money', { username: displayName, balance: senderBalance })}`);
        return;
      }

      changeBalance(sender, -amount);
      changeBalance(target, amount);
      saveEconomy();

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
        saveEconomy();

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
        saveEconomy();
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
        outputToDiscord(`\`\`\`\n${t('bot.cmd.list.none')}\n\`\`\``);
      } else {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.list.online', { count: online, players: players.join(', ') })}\n\`\`\``);
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
          outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.stopped')}\n\`\`\``);
        } else {
          outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.not_running')}\n\`\`\``);
        }
        break;
      }

      if (spammerInterval) {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.already_running')}\n\`\`\``);
        break;
      }

      if (args.length < 2) {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.usage', { prefix: config.botprefix })}\n\`\`\``);
        break;
      }

      const cooldown = parseInt(args[args.length - 1], 10);
      if (isNaN(cooldown) || cooldown <= 0) {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.invalid_cooldown')}\n\`\`\``);
        break;
      }

      const commandParts = args.slice(0, -1);
      const allIndex = commandParts.indexOf('all');

      let players = [];
      let cmdTemplate = [...commandParts];

      if (allIndex !== -1) {
        players = Object.keys(bot.players).filter(p => p !== bot.username);

        if (!players.length) {
          outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.no_players')}\n\`\`\``);
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

      outputToDiscord(`\`\`\`\n${t('bot.cmd.spammer.started', { command: activeSpammer, cooldown })}\n\`\`\``);
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
        let config_list = "```\n" + t('bot.cmd.config.list_header') + "\n";
        for (const [key, val] of Object.entries(config)) {
          if (hiddenParams.includes(key)) continue;
          const prettyName = paramMeta[key] || key;
          let display = val;
          if (typeof val === "boolean") display = val ? t('bot.yes') : t('bot.no');
          config_list += `${prettyName} (${key}): ${display}\n`;
        }
        config_list += `\n${t('bot.cmd.config.usage', { prefix: config.botprefix })}\n\`\`\``;
        outputToDiscord(config_list);
        break;
      }

      const param = args[0];
      const value = args[1];

      if (hiddenParams.includes(param)) {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.config.cannot_change', { param })}\`\`\``);
        break;
      }

      if (!(param in config)) {
        outputToDiscord(`\`\`\`\n${t('bot.cmd.config.unknown_param', { param })}\`\`\``);
        break;
      }

      let newValue;

      if (typeof config[param] === "boolean") {
        if (!["true", "false"].includes(value.toLowerCase())) {
          outputToDiscord(`\`\`\`\n${t('bot.cmd.config.boolean_usage', { param })}\`\`\``);
          break;
        }
        newValue = value.toLowerCase() === "true";
      } else if (typeof config[param] === "number") {
        newValue = parseInt(value, 10);
        if (isNaN(newValue)) {
          outputToDiscord(`\`\`\`\n${t('bot.cmd.config.invalid_value', { value })}\`\`\``);
          break;
        }
      } else {
        newValue = value;
      }

      config[param] = newValue;
      saveConfig();

      const displayValue = (typeof newValue === "boolean") ? (newValue ? t('bot.yes') : t('bot.no')) : newValue;
      const prettyName = paramMeta[param] || param;

      outputToDiscord(`\`\`\`\n${t('bot.cmd.config.updated', { param: prettyName, value: displayValue })}\`\`\``);
      break;
    }

    default: {
      if (source === 'mc') {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, ${t('bot.unknowncmd', { cmd: config.botprefix + cmd })}`);
      } else {
        await outputToDiscord(`\`\`\`\n${t('bot.unknowncmd', { cmd: config.botprefix + cmd })}\n\`\`\``);
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
          await outputToDiscord(`\`\`\`\n${combined}\n\`\`\``);
      } else if (pendingDiscordRun?.source === 'discord') {
        await outputToDiscord(`\`\`\`\n${t('bot.cmd.run.nomsg', { cmd: pendingDiscordRun.command })}\n\`\`\``);
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
        await logToDiscordChatLog(`${log.timestamp} :speech_balloon: **\`${realNick}\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
      }

      for (const cmd of data.commands) {
        try {
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
          await logToDiscordChatLog(`${log.timestamp} :speech_balloon: **\`Unknown Player (${displayNick})\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
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
      await outputToDiscord(msg);
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