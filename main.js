import 'dotenv/config';
import mineflayer from 'mineflayer';
import fetch from 'node-fetch';
import fs from 'fs';
import readline from 'readline';
import { Client, GatewayIntentBits, REST, EmbedBuilder } from 'discord.js';
import { exec } from "child_process";
import chalk from "chalk";
import yaml from 'js-yaml';

let config = {};

function loadConfig() {
  try {
    const file = fs.readFileSync('./settings/config.yml', 'utf8');
    config = yaml.load(file) || {};
  } catch (err) {
    console.error(
      chalk.bold.hex('#5fb857')('[Конфиг]') + ' ' +
      chalk.hex('#ff4040')('Ошибка загрузки:', err)
    );
    config = {};
  }
}

function saveConfig() {
  try {
    fs.writeFileSync('./settings/config.yml', yaml.dump(config, { indent: 2, lineWidth: -1 }), 'utf8');
    console.log(
      chalk.bold.hex('#5fb857')('[Конфиг]') + ' ' +
      chalk.hex('#7DFF7C')('Файл сохранен')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#5fb857')('[Конфиг]') + ' ' +
      chalk.hex('#ff4040')('Ошибка сохранения:', err)
    );
  }
}

loadConfig();

fs.watchFile('./settings/config.yml', () => {
  console.log(
    chalk.bold.hex('#5fb857')('[Конфиг]') + ' ' +
    chalk.hex('#ffc23d')('Обнаружено изменение, обновление...')
  );
  loadConfig();
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
let mutedUsers = {};
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

if (!process.env.TOGETHER_API_KEY) {
  console.error(chalk.hex('#FF0000')('❌ Ошибка: переменная TOGETHER_API_KEY не задана в .env'));
  process.exit(1);
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.botnick
});

process.on('uncaughtException', async (err) => {
  console.error('[uncaughtException]', err);

  try {
    await outputToDiscord(`\`\`\`\nUncaught Exception:\n${err.stack || err.message}\n\`\`\``);
  } catch (err) {
    console.error(chalk.hex('#FF7C7C')('Ошибка при отправке:', err));
  }
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('[unhandledRejection]', reason);

  try {
    await outputToDiscord(`\`\`\`\nUnhandled Rejection:\n${reason.stack || reason}\n\`\`\``);
  } catch (err) {
    console.error(chalk.hex('#FF7C7C')('Ошибка при отправке:', err));
  }
});

discordClient.login(process.env.DISCORD_TOKEN);

discordClient.once('ready', async () => {
  console.log(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#acacac')(`Бот авторизовался как ${discordClient.user.tag}`)
  );

  const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) return console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')('Сервер не найден!')
  );

  discordOutput = guild.channels.cache.get(process.env.DISCORD_CHANNEL_ID);
  if (!discordOutput) console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')('Канал команд не найден!')
  );

  discordLogOutput = guild.channels.cache.get(process.env.DISCORD_LOG_CHANNEL_ID);
  if (!discordLogOutput) console.warn(
    chalk.bold.hex('#7CB6FF')('[Discord]') + ' ' +
    chalk.hex('#FF7C7C')('Канал логов не найден!')
  );

  bot.once('spawn', async () => {
    const startType = process.env.pm_id !== undefined ? "PM2" : "Обычный";
    const ip = bot._client?.socket?.remoteAddress || bot.options?.host || 'Не указан';
    const port = bot._client?.socket?.remotePort || bot.options?.port || 'Не указан';
    const ipPort = `${ip}:${port}`;

    if (discordOutput) {
      const embed = {
        color: 0x00ff00,
        title: "🟢 Бот онлайн!",
        fields: [
          { name: "👤 Никнейм бота", value: `\`${bot.username}\``, inline: true },
          { name: "🛠️ Тип запуска", value: `\`${startType}\``, inline: true },
          { name: "🔌 IP", value: `\`${ipPort}\``, inline: true },
          { name: "🔧 Префикс бота", value: `\`${config.botprefix}\``, inline: true },
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
        chalk.hex('#FF7C7C')('Ошибка обработки команды:', err)
      );
      await msg.reply(`\`\`\`\nПроизошла ошибка при выполнении команды.\n\`\`\``);
    }
  }
});

discordClient.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'version') {
    await interaction.reply({
      content: [
        '<:asjdnc:1344009811288653824> Версия: **v2.0**',
        '<:ksjsk:1397677302602530826> Создатель: **exillrei**'
      ].join('\n'),
      ephemeral: false
    });
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
      chalk.hex('#FF7C7C')('Ошибка отправки сообщения:', err)
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
      chalk.hex('#FF7C7C')('Ошибка отправки:', err)
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
    const response = await fetch(
      'https://api.together.xyz/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
          messages: [
            {
              role: 'system',
              content: 'your content'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 512
        })
      }
    );

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content?.trim() || 'Сорри, у меня пусто';

    text = limitCharsByWords(text, 240);

    return text;
  } catch (err) {
    console.error('[Ошибка]', err);
    return 'Сорри, у меня ошибка';
  }
}

function loadGroups() {
  try {
    const file = fs.readFileSync('./settings/groups.yml', 'utf8');
    groups = yaml.load(file) || {};
    console.log(
      chalk.bold.hex('#17c717')('[Группы]') + ' ' +
      chalk.hex('#7DFF7C')('Загружены.')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#17c717')('[Группы]') + ' ' +
      chalk.hex('#FF7C7C')('Ошибка загрузки:', err)
    );
    groups = {};
  }
}
loadGroups();

fs.watchFile('./settings/groups.yml', () => {
  console.log(
    chalk.bold.hex('#17c717')('[Группы]') + ' ' +
    chalk.hex('#FFEA48')('Обнаружено изменение, обновление...')
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
      chalk.bold.hex('#a639ff')('[Чёрный список]') + ' ' +
      chalk.hex('#FF7C7C')('Ошибка загрузки:', err)
    );
    blacklist = [];
  }
}
function saveBlacklist() {
  try {
    fs.writeFileSync('./settings/blacklist.yml', yaml.dump(blacklist, { indent: 2, lineWidth: -1 }), 'utf8');
    console.log(
      chalk.bold.hex('#a639ff')('[Чёрный список]') + ' ' +
      chalk.hex('#7DFF7C')('Чёрный список сохранен')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#a639ff')('[Чёрный список]') + ' ' +
      chalk.hex('#FF7C7C')('Ошибка сохранения:', err)
    );
  }
}
loadBlacklist();

fs.watchFile('./settings/blacklist.yml', () => {
  console.log(
    chalk.bold.hex('#a639ff')('[Чёрный список]') + ' ' +
    chalk.hex('#FFEA48')('Обнаружено изменение, обновление...')
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
  if (role === 'moder' && ['run', 'msg', 'mute', 'unmute', 'blacklist'].includes(command)) {
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

  return `${days}д ${hours}ч ${minutes}м ${seconds}с`;
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
    const games = yaml.load(fs.readFileSync('chatgame.yml', 'utf8'));
    if (!Array.isArray(games) || games.length === 0) {
      console.log(
        chalk.bold.hex('#ff0000')('[Ошибка]') + ' ' +
        chalk.hex('#ff7c7c')('В чат-игре нет вопросов!')
      );
      return;
    }

    const game = games[Math.floor(Math.random() * games.length)];
    game.rewards = DefaultChatGameRewards;

    currentGame = game;
    awaitingAnswer = true;

    bot.chat(`/me &8[&e❓&8] &dЧат-игра! Вопрос: &b${game.question}`);

    clearTimeout(gameTimeout);
    gameTimeout = setTimeout(() => {
      if (awaitingAnswer) {
        awaitingAnswer = false;
        currentGame = null;
        bot.chat(`/me &8[&#FF0000❓&8] &cВремя вышло! Никто не ответил правильно.`);
      }
    }, 30 * 1000);
  } catch (err) {
    console.error(
      chalk.bold.hex('#ff0000')('[Ошибка]') + ' ' +
      chalk.hex('#ff7c7c')('Ошибка при чтении chatgame.yml:', err)
    );
  }
}

setInterval(() => {
  if (!awaitingAnswer && bot.player) {
    startChatGame();
  }
}, 3 * 30 * 1000);

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
    bot.chat(`/me &8[&a❓&8] &e${username} &aдал правильный ответ и получил &e${reward}⛃!`);
  } else {
    bot.chat(`/me &8[&a❓&8] &e${username} &aдал правильный ответ, но не повезло с наградой :(`);
  }
  currentGame = null;
}

async function handleChat(usernameRaw, message) {
  try {
    const username = cleanName(usernameRaw);
    if (username === bot.username && !message.startsWith(`${config.botprefix}cmd`)) return;
    if (isDuplicateMessage(username, message)) return;

    if (pendingDiscordRun) {
      await outputToDiscord(`\`\`\`\n${message}\n\`\`\``);
      pendingDiscordRun = null;
    }

    if (usernameRaw.startsWith('~')) {
      const displayNick = usernameRaw.toLowerCase();

      if (!nickMap.has(displayNick)) {
        pendingCommands.set(displayNick, { username: usernameRaw, message });
        requestRealName(usernameRaw);
        return;
      } else {
        const realUsername = nickMap.get(displayNick);
        await processUserCommand(realUsername, message);
        return;
      }
    }

    await processUserCommand(username.toLowerCase(), message);

  } catch (err) {
    console.error(chalk.hex('#FF7C7C')('[handleChat ошибка]', err));
  }
}

async function sendLongMessage(realUsername, text) {
  const resolvedUsername = resolveUsername(realUsername);
  const originalCasedUsername = resolvedUsername;
  const maxLen = 220;
  let remaining = text;

  while (remaining.length > 0) {
    const chunk = limitCharsByWords(remaining, maxLen);
    await bot.chat(`!&6${originalCasedUsername}, &f${chunk}`);
    remaining = remaining.slice(chunk.length).trim();
    await new Promise(r => setTimeout(r, 7000));
  }
}

function loadMutes() {
  try {
    const file = fs.readFileSync('./settings/muted.yml', 'utf8');
    mutedUsers = yaml.load(file) || {};
  } catch {
    mutedUsers = {};
  }
}
function saveMutes() {
  fs.writeFileSync('./settings/muted.yml', yaml.dump(mutedUsers, { indent: 2, lineWidth: -1 }), 'utf8');
}
loadMutes();

setInterval(() => {
  let changed = false;

  for (const [username, { unmuteAt }] of Object.entries(mutedUsers)) {
    if (Date.now() > unmuteAt) {
      delete mutedUsers[username];
      changed = true;
      console.log(
        chalk.bold.hex('#AFFF48')('[Мут]') + ' ' +
        chalk.hex('#a1a1a1')('Игрок') + ' ' +
        chalk.hex('#ffa53e')(`${username}`) + ' ' +
        chalk.hex('#a1a1a1')('автоматически размучен (время истекло)')
      );
    }
  }

  if (changed) saveMutes();
}, 10 * 1000);

function muteUser(username, durationMs, reason) {
  const unmuteAt = Date.now() + durationMs;
  mutedUsers[username.toLowerCase()] = { unmuteAt, reason };
  saveMutes();
}

function unmuteUser(username) {
  delete mutedUsers[username.toLowerCase()];
  saveMutes();
}

function isMuted(username) {
  const entry = mutedUsers[username.toLowerCase()];
  if (!entry) return false;
  if (Date.now() > entry.unmuteAt) {
    unmuteUser(username);
    return false;
  }
  return true;
}

function checkMute(username, originalCasedUsername) {
  if (isMuted(username)) {
    const { unmuteAt, reason } = mutedUsers[username.toLowerCase()];
    const msLeft = unmuteAt - Date.now();
    const timeLeft = formatDuration(msLeft);
    bot.chat(`/me &8[&#FF0000✘&8] &6${originalCasedUsername}, вам заткнули рот! Вам сидеть ещё: &e${timeLeft} &8| &6Причина: &e${reason}`);
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
      chalk.bold.hex('#ff5100')('[Экономика]') + ' ' +
      chalk.hex('#FF7C7C')('Файл не найден или повреждён, создаю новый')
    );
    economy = {};
    saveEconomy();
  }
}
function saveEconomy() {
  fs.writeFileSync('./settings/economy.yml', yaml.dump(economy, { indent: 2, lineWidth: -1 }), 'utf8');
  console.log(
    chalk.bold.hex('#ff5100')('[Экономика]') + ' ' +
    chalk.hex('#7DFF7C')('Экономика сохранена')
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
      chalk.bold.hex('#ffd900')('[Магазин]') + ' ' +
      chalk.hex('#7DFF7C')('Загружен.')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#ffd900')('[Магазин]') + ' ' +
      chalk.hex('#FF7C7C')('Ошибка при загрузки:', err)
    );
    shop = [];
  }
}
loadShop();

fs.watchFile('./settings/shop.yml', () => {
  console.log(
    chalk.bold.hex('#ffd900')('[Магазин]') + ' ' +
    chalk.hex('#e7ff7c')('Обнаружены изменения, обновление...')
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
const codeFile = './settings/codes.yml';

function loadCodes() {
  try {
    const file = fs.readFileSync(codeFile, 'utf8');
    codesCache = yaml.load(file) || {};
    console.log(
      chalk.bold.hex('#ff1d3b')('[Коды]') + ' ' +
      chalk.hex('#7DFF7C')('Загружены.')
    );
  } catch (err) {
    console.error(
      chalk.bold.hex('#ff1d3b')('[Коды]') + ' ' +
      chalk.hex('#FF7C7C')('Ошибка загрузки:', err)
    );
    codesCache = {};
  }
}

loadCodes();
fs.watchFile(codeFile, () => {
  console.log(
    chalk.bold.hex('#ff1d3b')('[Коды]') + ' ' +
    chalk.hex('#FFEA48')('Обнаружено изменение, обновление...')
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

  if (realUsername.toLowerCase() === bot.username.toLowerCase()) return;

  const trimmed = (message || '').trim();
  if (!trimmed.startsWith(config.botprefix)) return;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(config.botprefix, '');

  if (source === 'discord' && discordBlockedCommands.includes(cmd)) {
    await outputToDiscord(`\`\`\`\n${displayName}, команда ${config.botprefix}${cmd} недоступна через Discord.\n\`\`\``);
    return;
  }

  if (isConsole) {
    if (!userPerms['CONSOLE']) userPerms['CONSOLE'] = ['*'];
  }

  if (checkMute(realUsername.toLowerCase(), resolvedUsername)) return;

  if (isBlacklisted(realUsername)) {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, вы в чёрном списке бота!`);
    return;
  }

  if (!alwaysAllowed.includes(cmd) && !isConsole) {
    if (!hasPermission(realUsername, cmd)) {
      await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, у вас нет доступа к &e${config.botprefix}${cmd}!`);
      return;
    }
  }

  if (config.testmode && realUsername.toLowerCase() !== ownerUsername.toLowerCase() && source == 'mc') {
    await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, идёт тестирование бота, подождите!`);
    return;
  }

  switch (cmd) {
    case 'help': {
      const effectiveUsername = source === 'discord' ? originalSender : realUsername;
      const role = getRole(effectiveUsername);

      const commandDescriptions = {
        help: 'Показывает список доступных команд',
        msg: 'Отправляет сообщение в чат от имени бота',
        run: 'Выполняет серверную команду от имени бота',
        exit: 'Завершить работу бота',
        restart: 'Перезапустить бота',
        info: 'Показывает информацию о боте',
        blacklist: 'Управление чёрным списком',
        mute: 'Временно запрещает игроку использовать бота',
        unmute: 'Снимает мут с игрока',
        cmd: 'Выдаёт или забирает доступ к командам',
        eco: 'Управление экономикой бота',
        rape: '💀💀💀',
        list: 'Список игроков на сервере',
        spammer: 'Спам командами',
        config: 'Настройки бота'
      };

      const commandsByRole = {
        owner: ['help', 'msg', 'run', 'exit', 'info', 'blacklist', 'mute', 'unmute', 'cmd',
          'feedback', 'balance', 'shop', 'pay', 'eco', 'code', 'restart', 'bcode'],
        moder: ['help', 'msg', 'run', 'info', 'mute', 'unmute', 'blacklist',
          'feedback', 'balance', 'shop', 'pay', 'code'],
        user: ['help', 'info', 'feedback', 'balance', 'shop', 'pay', 'code']
      };

      const baseCommands = commandsByRole[role] || [];
      const extraPerms = userPerms[effectiveUsername.toLowerCase()] || [];
      let all = [...new Set([...baseCommands, ...extraPerms])];

      if (source === 'discord') {
        all = all.filter(c => !discordBlockedCommands.includes(c));
      }

      if (source === 'mc') {
        const withPrefix = all.map(c => config.botprefix + c);
        await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &aтвои доступные команды: &e${withPrefix.join(', ')}`);
      } else {
        const detailedList = Object.entries(commandDescriptions)
          .map(([cmd, desc]) => `${config.botprefix}${cmd} » ${desc || 'Нет описания.'}`)
          .join('\n');
        await outputToDiscord(`\`\`\`\n${detailedList}\n\`\`\``);
      }
      break;
    }

    case 'info': {
      const uptime = Date.now() - startTime;
      const formatted = formatUptime(uptime);
      if (source === 'mc') {
        await bot.chat(`/me &8[&e✦&8] &e${displayName}, &aСоздатель бота: &#FF5500🔥 exillrei 🔥 &8| &aСписок команд: &e${config.botprefix}help &8| &aОбщение с нейросетью: &#00FF89хомяк, ваш текст &8| &aАптайм бота: &#009EFF${formatted} ⌚`);
      } else {
        await outputToDiscord(`\`\`\`\nСоздатель бота: exillrei\nСписок команд: ${config.botprefix}help\nАптайм бота: ${formatted} ⌚\n\`\`\``);
      }
      break;
    }

    case 'msg': {
      const msgText = parts.slice(1).join(' ').trim();
      if (!msgText) break;

      if (msgText.includes(config.botprefix)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, в ${config.botprefix}msg запрещено использовать команды бота.`);
        } else {
          await outputToDiscord(`\`\`\`\nв ${config.botprefix}msg запрещено использовать команды бота.\n\`\`\``);
        }
        break;
      }

      if (config.msg_hidename) {
        await bot.chat(`!${msgText}`);
      } else {
        await bot.chat(`!&6Сообщение от &a${displayName}: ${msgText}`);
      }

      if (source === 'discord') await outputToDiscord(`\`\`\`\nСообщение отправлено.\n\`\`\``);
      break;
    }

    case 'run': {
      const cmdToRun = parts.slice(1).join(' ').trim();
      const cmdLower = cmdToRun.toLowerCase();

      if (!cmdToRun) break;

      if (cmdToRun.includes(config.botprefix)) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, в ${config.botprefix}run запрещено использовать команды бота.`);
        } else {
          await outputToDiscord(`\`\`\`\nв ${config.botprefix}run запрещено использовать команды бота.\n\`\`\``);
        }
        break;
      }

      if (bannedRunCommands.some(b => cmdLower.startsWith(b))) {
        if (source === 'mc') {
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, эта команда запрещена для использования.`);
        } else {
          await outputToDiscord(`\`\`\`\nЭта команда запрещена для использования.\n\`\`\``);
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
            await outputToDiscord(`\`\`\`\nКоманда "${pendingDiscordRun.command}" не вернула сообщений.\n\`\`\``);
          }
        }
        pendingDiscordRun = null;
        collectedRunOutput = [];
      }, 500);

      break;
    }

    case 'exit': {
      if (source === 'mc') await bot.chat('/me &8[&#FF0000⏻&8] &6Бот завершает работу...');
      if (source === 'discord') await outputToDiscord("```\nБот завершает работу...\n```");
      console.log(chalk.hex('#61EFFF')('[Бот] Завершение работы...'));

      if (process.env.pm_id !== undefined) {
        const parentPid = process.ppid;
        if (process.platform === "win32") {
          exec(`taskkill /c /PID ${process.pid} /T /F & taskkill /PID ${parentPid} /T /F`, (err, stdout, stderr) => {
            if (err) console.error(chalk.hex('#FF7C7C')("Ошибка при завершении:", err));
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
          });
        } else if (process.platform === "linux") {
          exec(`kill -9 ${process.pid} ${parentPid}`, (err, stdout, stderr) => {
            if (err) console.error(chalk.hex('#FF7C7C')("Ошибка при завершении:", err));
            if (stdout) console.log(stdout);
            if (stderr) console.error(stderr);
          });
        } else {
          console.log(chalk.hex('#61EFFF')("Неизвестная платформа, завершаю через process.exit()"));
          process.exit(0);
        }

      } else {
        process.exit(0);
      }
      break;
    }

    case 'restart': {
      if (process.env.pm_id !== undefined) {
        if (source === 'mc') await bot.chat('/me &8[&#00FF00⟳&8] &6Бот перезапускается...');
        if (source === 'discord') await outputToDiscord("```\nБот перезапускается...\n```");
        console.log(chalk.hex('#61EFFF')('[Бот] Перезапуск...'));

        exec(`pm2 restart ${process.env.pm_id}`, (err, stdout, stderr) => {
          if (err) console.error(chalk.hex('#FF7C7C')("Ошибка перезапуска:", err));
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
          process.exit(0);
        });
      } else {
        if (source === 'mc') await bot.chat('/me &8[&#FF0000✘&8] Перезапуск недоступен, тип запуска: Обычный');
        if (source === 'discord') await outputToDiscord("```\nПерезапуск недоступен, тип запуска: Обычный\n```");
      }
      break;
    }

    case 'blacklist': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];
      if (!['add', 'remove', 'info'].includes(subcmd || '')) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используйте: &e${config.botprefix}blacklist &aadd&8/&cremove &8<&eник&8> &8| &e${config.botprefix}blacklist info`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}blacklist add/remove <ник> | ${config.botprefix}blacklist info\n\`\`\``);
        return;
      }

      if (subcmd === 'info') {
        if (!blacklist.length) {
          if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &cчёрный список пуст.`);
          else await outputToDiscord(`\`\`\`\nЧёрный список пуст.\n\`\`\``);
        } else {
          if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &e${displayName}, &aв чёрном списке: &c${blacklist.join(', ')}`);
          else await outputToDiscord(`\`\`\`\nВ чёрном списке: ${blacklist.join(', ')}\n\`\`\``);
        }
        break;
      }

      if (!targetUser) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используйте: &e${config.botprefix}blacklist &b${subcmd} &8<&eник&8>`);
        else await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}blacklist ${subcmd} <ник>\`\`\``);
        break;
      }

      const target = targetUser.toLowerCase();
      const role = getRole(target);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, нельзя добавить/удалить ${role === 'owner' ? 'владельца' : 'модера'} в чёрный список.`);
        else await outputToDiscord(`\`\`\`\nНельзя добавить/удалить ${role === 'owner' ? 'владельца' : 'модера'} в чёрный список.\`\`\``);
        break;
      }

      if (subcmd === 'add') {
        if (isBlacklisted(target)) {
          if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, игрок &e${targetUser} &cуже в чёрном списке.`);
          else await outputToDiscord(`\`\`\`\nИгрок ${targetUser} уже в чёрном списке.\`\`\``);
        } else {
          addToBlacklist(target);
          await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aдобавил в чёрный список игрока &e${targetUser}`);
          if (source === 'discord') await outputToDiscord(`\`\`\`\nВы добавили игрока ${targetUser} в чёрный список.\`\`\``);
          saveBlacklist();
        }
      } else if (subcmd === 'remove') {
        if (!isBlacklisted(target)) {
          if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, игрок &e${targetUser} &cне в чёрном списке.`);
          else await outputToDiscord(`\`\`\`\nИгрок ${targetUser} не в чёрном списке.\`\`\``);
        } else {
          removeFromBlacklist(target);
          await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aубрал с чёрного списка игрока &e${targetUser}`);
          if (source === 'discord') await outputToDiscord(`\`\`\`\nВы убрали игрока ${targetUser} из чёрного списка.\`\`\``);
          saveBlacklist();
        }
      }
      break;
    }

    case 'mute': {
      const targetUser = parts[1];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const timeStr = parts[2];
      const reason = parts.slice(3).join(' ') || 'Без причины';

      if (!target || !timeStr || !/^\d+[smhd]$/.test(timeStr)) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используйте: &e${config.botprefix}mute &8<&eник&8> &8<&bвремя&8> &8<&aпричина&8>`);
        else await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}mute <ник> <время> <причина>\`\`\``);
        return;
      }

      const role = getRole(target);
      if (!isConsole && (role === 'moder' || role === 'owner')) {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, нельзя заткнуть рот ${role === 'owner' ? 'владельцу' : 'модеру'}.`);
        else await outputToDiscord(`\`\`\`\nНельзя заткнуть рот ${role === 'owner' ? 'владельцу' : 'модеру'}.\`\`\``);
        return;
      }

      const unit = timeStr.slice(-1);
      const value = parseInt(timeStr.slice(0, -1), 10);
      const ms = unit === 's' ? value * 1000 :
        unit === 'm' ? value * 60 * 1000 :
          unit === 'h' ? value * 60 * 60 * 1000 :
            unit === 'd' ? value * 24 * 60 * 60 * 1000 : 0;

      if (!ms) {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, неверный формат времени.`);
        else await outputToDiscord(`\`\`\`\nНеверный формат времени.\`\`\``);
        return;
      }

      muteUser(target, ms, reason);
      await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aзатутил &e${targetUser} &aна &e${timeStr} &8| &aПричина: &e${reason}`);
      if (source === 'discord') await outputToDiscord(`\`\`\`\nВы замутили ${targetUser} на ${timeStr} | Причина: ${reason}\`\`\``);
      break;
    }

    case 'unmute': {
      const targetUser = parts[1];
      const target = targetUser ? targetUser.toLowerCase() : null;
      if (!target) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используйте: &e${config.botprefix}unmute &8<&eник&8>`);
        else await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}unmute <ник>\`\`\``);
        return;
      }
      if (!mutedUsers[target]) {
        if (source === 'mc') await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, игрок &e${targetUser} &cне в муте.`);
        else await outputToDiscord(`\`\`\`\nИгрок ${targetUser} не в муте.\`\`\``);
        return;
      }
      unmuteUser(target);
      await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aразмутил &e${targetUser}.`);
      if (source === 'discord') await outputToDiscord(`\`\`\`\nВы размутили ${targetUser}\`\`\``);
      break;
    }

    case 'cmd': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const targetCommand = parts[3]?.toLowerCase().replace(config.botprefix, '');

      if (!['give', 'take'].includes(subcmd || '') || !target || !targetCommand) {
        if (source === 'mc') await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используйте: &e${config.botprefix}cmd &agive&8/&ctake &8<&eник&8> &8<&6команда&8>`);
        else await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}cmd give/take <ник> <команда>\`\`\``);
        return;
      }

      if (subcmd === 'give') {
        grantPermission(target, targetCommand);
        await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aвыдал доступ к команде &6${targetCommand} &aигроку &b${targetUser}`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\nВы выдали доступ к команде ${targetCommand} игроку ${targetUser}\`\`\``);
      } else {
        revokePermission(target, targetCommand);
        await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName} &aотобрал доступ к команде &6${targetCommand} &aигроку &b${targetUser}`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\nВы отобрали доступ к команде ${targetCommand} игроку ${targetUser}\`\`\``);
      }
      break;
    }

    case 'feedback': {
      const subcmd = parts[1]?.toLowerCase();
      if (!subcmd || !['send', 'random', 'info', 'total'].includes(subcmd)) {
        await bot.chat(`/me &8[&e🛈&8] &c${displayName}, используй: &e${config.botprefix}feedback send &8<&dтекст&8> &8| &e${config.botprefix}feedback random &8| &e${config.botprefix}feedback info &8<&eник&8> &8| &e${config.botprefix}feedback total`);
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
          await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, укажите текст отзыва.`);
          return;
        }
        feedbackData[originalCasedUsername] = feedbackText;
        fs.writeFileSync(file, yaml.dump(feedbackData, { indent: 2, lineWidth: -1 }), 'utf-8');
        await bot.chat(`/me &8[&#00ff00✔&8] &e${displayName}, &aотзыв сохранен. Спасибо! &c❤`);
      }

      if (subcmd === 'random') {
        const keys = Object.keys(feedbackData);
        if (keys.length === 0) {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, отзывов пока нет.`);
          return;
        }
        const randomUser = keys[Math.floor(Math.random() * keys.length)];
        const feedback = feedbackData[randomUser];
        await bot.chat(`/me &8[&e🛈&8] &6Отзыв от &e${randomUser}: &f${feedback}`);
      }

      if (subcmd === 'total') {
        const total = Object.keys(feedbackData).length;
        await bot.chat(`/me &8[&e🛈&8] &6${displayName}, всего отзывов о боте: &e${total}`);
      }

      if (subcmd === 'info') {
        const targetUser = parts[1];
        const target = targetUser ? targetUser.toLowerCase() : null;
        if (!target) {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, укажите ник: &e${config.botprefix}feedback info &8<&eник&8>`);
          return;
        }
        const feedbackEntry = Object.entries(feedbackData).find(([name]) => name.toLowerCase() === target);
        if (!feedbackEntry) {
          await bot.chat(`/me &8[&e🛈&8] &c${displayName}, отзыв игрока &e${targetUser} &cне найден.`);
          return;
        }
        const [name, feedbackText] = feedbackEntry;
        await bot.chat(`/me &8[&e🛈&8] &6Отзыв от &e${name}: &f${feedbackText}`);
      }
      break;
    }

    case 'rape': {
      const target = parts[1];
      if (!target) {
        await bot.chat(`/me &8[&e🛈&8] &c${displayName}, укажите ник: &e${config.botprefix}rape &8<&eник&8>`);
        return;
      }
      const diseases = [
        'спидом', 'сифилисом', 'гонореей', 'вичом', 'саркомой', 'грибком',
        'кандидозом', 'трихомониазом', 'герпесом', 'хламидозом', 'уреаплазмозом',
        'микоплазмозом', 'синдромом долбаеба'
      ];
      const randomDisease = diseases[Math.floor(Math.random() * diseases.length)];
      await bot.chat(`/me &8[&#D600FF☢&8] &e${displayName} &aзаразил &d${randomDisease} &aигрока &b${target}.`);
      if (source === 'discord') await outputToDiscord(`\`\`\`\nВы заразили ${randomDisease} игрока ${target}.\`\`\``);
      break;
    }

    case 'balance': {
      const arg = parts[1]?.toLowerCase();
      const username = realUsername.toLowerCase();

      if (arg === 'top') {
        const entries = Object.entries(economy);
        if (!entries.length) {
          await bot.chat(`/me &8[&6⛃&8] &cТоп по балансу пуст.`);
          break;
        }
        const topPlayers = entries
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([user, bal], i) => `&d${i + 1}. &a${user} &7- &6${bal}⛃`)
          .join(' &8| ');
        await bot.chat(`/me &8[&6⛃&8] &eТоп по балансу: ${topPlayers}`);
        break;
      }

      if (arg && arg !== username) {
        const targetBalance = economy[arg];
        if (targetBalance != null) {
          await bot.chat(`/me &8[&6⛃&8] &e${displayName}, &aбаланс &e${arg}: &6${targetBalance}⛃`);
        } else {
          await bot.chat(`/me &8[&6⛃&8] &c${displayName}, Игрок не найден.`);
        }
        break;
      }

      const balance = economy[username] ?? 0;
      await bot.chat(`/me &8[&6⛃&8] &e${displayName}, &aтвой баланс: &6${balance}⛃.`);
      break;
    }

    case 'eco': {
      const subcmd = parts[1]?.toLowerCase();
      const targetUser = parts[2];
      const target = targetUser ? targetUser.toLowerCase() : null;
      const amount = parseInt(parts[3], 10);

      if (!['give', 'take'].includes(subcmd || '') || !targetUser || isNaN(amount)) {
        if (source === 'mc') await bot.chat(`/me &8[&6⛃&8] &c${displayName}, используйте: &e${config.botprefix}eco &agive&8/&ctake &8<&eник&8> &8<&aсумма&8>`);
        else await outputToDiscord(`\`\`\`\nИспользуйте: ${config.botprefix}eco give/take <ник> <сумма>\`\`\``);
        return;
      }

      if (subcmd === 'give') {
        changeBalance(target, amount);
        await bot.chat(`/me &8[&6⛃&8] &e${displayName} &aвыдал игроку &b${targetUser} &6${amount}⛃.`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\nВы выдали игроку ${targetUser} ${amount} монет.\`\`\``);
      } else {
        changeBalance(target, -amount);
        await bot.chat(`/me &8[&6⛃&8] &e${displayName} &aзабрал у игрока &b${targetUser} &6${amount}⛃.`);
        if (source === 'discord') await outputToDiscord(`\`\`\`\nВы забрали у игрока ${targetUser} ${amount} монет.\`\`\``);
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
        await bot.chat(`/me &8[&6⛃&8] &e${displayName}, &aиспользуйте: &e${config.botprefix}pay &8<&eник&8> &8<&aсумма&8>`);
        return;
      }

      if (target === sender) {
        await bot.chat(`/me &8[&#FF0000⛃&8] &c${displayName}, нельзя перевести монеты самому себе.`);
        return;
      }

      const senderBalance = getBalance(sender);
      if (senderBalance < amount) {
        await bot.chat(`/me &8[&#FF0000⛃&8] &c${displayName}, недостаточно монет! У тебя только &6${senderBalance}⛃.`);
        return;
      }

      changeBalance(sender, -amount);
      changeBalance(target, amount);
      saveEconomy();

      await bot.chat(`/me &8[&#00FF00⛃&8] &e${displayName}, &aвы перевели игроку &b${targetUser} &6${amount}⛃.`);
      break;
    }

    case 'shop': {
      const subcmd = parts[1]?.toLowerCase();
      const itemId = parts[2]?.toLowerCase();
      const buyer = realUsername.toLowerCase();
      const oneTimeItems = ['rape'];

      if (!shop || !Array.isArray(shop)) {
        await bot.chat(`/me &8[&#FF0000⛃&8] &e${displayName}, &cМагазин временно недоступен.`);
        return;
      }

      if (!subcmd) {
        const list = shop.map(i => `&e${i.name} &8(&6${i.price}⛃&8)`).join('&e, ');
        await bot.chat(`/me &8[&6⛃&8] &e${displayName}, &aтовары в магазине: ${list}`);
        return;
      }

      if (subcmd === 'buy') {
        if (!itemId) {
          await bot.chat(`/me &8[&6⛃&8] &c${displayName}, используйте: &e${config.botprefix}shop buy &8<&dтовар&8>`);
          return;
        }

        const item = shop.find(i => i.id.toLowerCase() === itemId || i.name.toLowerCase() === itemId);
        if (!item) {
          await bot.chat(`/me &8[&#00FF00⛃&8] &c${displayName}, товар &e"${itemId}"&c не найден.`);
          return;
        }

        const itemKey = item.id.toLowerCase();

        if (oneTimeItems.includes(itemKey)) {
          if (!purchases[buyer]) purchases[buyer] = [];
          if (purchases[buyer].includes(itemKey)) {
            await bot.chat(`/me &8[&#FF0000⛃&8] &c${displayName}, ты уже покупал &e"${item.name}"&c и не можешь купить его снова.`);
            return;
          }
        }

        const bal = getBalance(buyer);
        if (bal < item.price) {
          await bot.chat(`/me &8[&#FF0000⛃&8] &c${displayName}, недостаточно монет для покупки &e${item.name} &8(&6${item.price}⛃&8).`);
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

        await bot.chat(`/me &8[&#00FF00⛃&8] &e${displayName}, &aвы купили &e"${item.name}"&a за &e${item.price}⛃.`);
      } else {
        await bot.chat(`/me &8[&#FF0000⛃&8] &c${displayName}, неизвестная подкоманда магазина. Используйте: &e${config.botprefix}shop buy`);
      }
      break;
    }

    case 'code': {
      const codeName = parts[1]?.toLowerCase();
      if (!codeName) {
        await bot.chat(`/me &8[&e🛈&8] &c${displayName}, укажите код: &e${config.botprefix}code &8<&cкод&8>`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, код &e${codeName} &cне найден.`);
        return;
      }

      const username = realUsername.toLowerCase();
      const alreadyUsed = codeObj.usedBy?.includes(username);
      if (alreadyUsed && (codeObj.perPlayerLimit ?? 1) <= 1) {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, вы уже использовали этот код.`);
        return;
      }

      if (codeObj.globalLimit && (codeObj.usedTotal || 0) >= codeObj.globalLimit) {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, лимит использования этого кода исчерпан.`);
        return;
      }

      if (codeObj.action?.type === 'money') {
        const amount = codeObj.action.amount || 0;
        changeBalance(username, amount);
        saveEconomy();
        await bot.chat(`/me &8[&#00ff00🛈&8] &e${displayName}, &aкод активирован! Вы получили: &6${amount}⛃`);
      }

      if (codeObj.action?.type === 'command') {
        const c = codeObj.action.command.replace('{player}', originalCasedUsername);
        bot.chat(c);
      }

      if (!codeObj.usedBy) codeObj.usedBy = [];
      codeObj.usedBy.push(username);
      codeObj.usedTotal = (codeObj.usedTotal || 0) + 1;
      fs.writeFileSync(codeFile, yaml.dump(codesCache, { indent: 2, lineWidth: -1 }), 'utf8');
      break;
    }

    case 'bcode': {
      const codeName = parts[1]?.toLowerCase();
      if (!codeName) {
        await bot.chat(`/me &8[&e🛈&8] &c${displayName}, укажите код: &e${config.botprefix}bcode &8<&cкод&8>`);
        return;
      }

      const codeObj = codesCache[codeName];
      if (!codeObj) {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, код &e${codeName} &cне найден.`);
        return;
      }

      const remaining = (codeObj.globalLimit || 0) - (codeObj.usedTotal || 0);
      let rewardInfo = ''; // Можно по желанию добавить в bot.chat
      switch (codeObj.action?.type) {
        case 'money': rewardInfo = `${codeObj.action.amount || 0}⛃`; break;
        case 'command': rewardInfo = `команда бота`; break;
        default: rewardInfo = 'неизвестно';
      }

      await bot.chat(`/me &#FFD700Для всех доступен код: &#FF0000${codeName} &#FFD700на &#FF0000${Math.max(0, remaining)} &#FFD700активаций. &#FFD700(${config.botprefix}code ${codeName})`);
      break;
    }

    case 'list': {
      if (source === 'mc') return;
      const players = Object.keys(bot.players);
      const online = players.length;

      if (online === 0) {
        outputToDiscord(`\`\`\`\nИгроков на сервере нет.\n\`\`\``);
      } else {
        outputToDiscord(`\`\`\`\nИгроки онлайн (${online}): ${players.join(', ')}\n\`\`\``);
      }
      break;
    }

    case 'spammer': {
      if (source === 'mc') return;
      const args = message.trim().split(/\s+/).slice(1);

      if (args[0] === "stop") {
        if (spammerInterval || activeCmd) {
          clearInterval(spammerInterval);
          spammerInterval = null;
          activeSpammer = null;
          outputToDiscord(`\`\`\`\nСпаммер выключен.\`\`\``);
        } else {
          outputToDiscord(`\`\`\`\nСпаммер не включен!\`\`\``);
        }
        break;
      }

      if (activeSpammer) {
        outputToDiscord(`\`\`\`\nСпамер уже включён! (Команда: /${activeSpammer})\`\`\``);
        break;
      }

      if (!args[0] || !args[1]) {
        outputToDiscord(`\`\`\`\nИспользование: ${config.botprefix}spammer <команда> <кд> | ${config.botprefix}spammer stop\`\`\``);
        break;
      }

      const serverCommand = args.slice(0, -1).join(" ");
      const cooldown = parseInt(args[args.length - 1], 10)

      if (isNaN(cooldown) || cooldown <= 0) {
        outputToDiscord(`\`\`\`\nУкажите нормальное кд (в миллисекундах!)\`\`\``);
        break
      }

      activeSpammer = serverCommand;
      spammerInterval = setInterval(() => {
        bot.chat(`/${serverCommand}`);
      }, cooldown);

      outputToDiscord(`\`\`\`\nЗапущена команда: /${serverCommand} (каждые ${cooldown} мс)\`\`\``);
      break;
    }

    case 'config': {
      if (source === 'mc') return;
      const args = message.trim().split(/\s+/).slice(1);

      const paramMeta = {
        msg_hidename: `Скрывать имя пользователя в ${config.botprefix}msg`,
        botprefix: "Префикс бота",
        autoconsole: "Авто-включение /console",
        testmode: "Режим тестирования"
      };

      const hiddenParams = ['host', 'port', 'botnick'];

      if (!args[0]) {
        let config_list = "```\nНастройки бота:\n";
        for (const [key, val] of Object.entries(config)) {
          if (hiddenParams.includes(key)) continue;
          const prettyName = paramMeta[key] || key;
          let display = val;
          if (typeof val === "boolean") display = val ? "Да" : "Нет";
          config_list += `${prettyName} (${key}): ${display}\n`;
        }
        config_list += `\nИспользование: ${config.botprefix}config <параметр> <значение>\n\`\`\``;
        outputToDiscord(config_list);
        break;
      }

      const param = args[0];
      const value = args[1];

      if (hiddenParams.includes(param)) {
        outputToDiscord(`\`\`\`\nПараметр "${param}" нельзя изменить через команду. Измените его вручную в config.yml.\`\`\``);
        break;
      }

      if (!(param in config)) {
        outputToDiscord(`\`\`\`\nНеизвестный параметр: ${param}\`\`\``);
        break;
      }

      let newValue;

      if (typeof config[param] === "boolean") {
        if (!["true", "false"].includes(value.toLowerCase())) {
          outputToDiscord(`\`\`\`\nДля параметра "${param}" используйте: true/false\`\`\``);
          break;
        }
        newValue = value.toLowerCase() === "true";
      } else if (typeof config[param] === "number") {
        newValue = parseInt(value, 10);
        if (isNaN(newValue)) {
          outputToDiscord(`\`\`\`\nНеверное значение: ${value}\`\`\``);
          break;
        }
      } else {
        newValue = value;
      }

      config[param] = newValue;
      saveConfig();

      const displayValue = (typeof newValue === "boolean")
        ? (newValue ? "true" : "false")
        : newValue;

      const prettyName = paramMeta[param] || param;

      outputToDiscord(`\`\`\`\nПараметр "${prettyName}" обновлён: ${displayValue}\`\`\``);
      break;
    }


    default: {
      if (source === 'mc') {
        await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, неизвестная команда: &e${config.botprefix}${cmd}`);
      } else {
        await outputToDiscord(`\`\`\`\nНеизвестная команда: ${config.botprefix}${cmd}\`\`\``);
      }
      break;
    }
  }

  if (message.toLowerCase().includes('ботяра,')) {
    if (checkMute(realUsername.toLowerCase(), resolvedUsername)) return;

    if (isBlacklisted(realUsername)) {
      await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, вы в чёрном списке бота!`);
      return;
    }

    const now = Date.now();
    if (now - lastBotCall < botCooldown) {
      await bot.chat(`/me &8[&#FF0000✘&8] &c${displayName}, подождите немного, бот отдыхает`);
      return;
    }
    lastBotCall = now;

    const parts = message.toLowerCase().split('ботяра,');
    if (parts.length < 2) return;

    const prompt = parts[1].trim();
    if (!prompt) return;

    await bot.chat(`!&6${displayName}, думаю...`);
    const reply = await queryAI(prompt);
    await sendLongMessage(originalCasedUsername, reply);
  }
}

bot.on('login', () => {
  console.log(
    chalk.bold.hex('#61EFFF')('[Бот]') + ' ' +
    chalk.hex('#acacac')('Вошёл в игру')
  );
});

bot.once('spawn', async () => {
  console.log(
    chalk.bold.hex('#61EFFF')('[Бот]') + ' ' +
    chalk.hex('#acacac')('Вошёл, отправляю /games...')
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
  const msg = `${timestamp}\n🟢 Игрок **\`${player.username.replace(/([*`~])/g, '\\$1')}\`** вошёл.`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

bot.on('playerLeft', (player) => {
  const timestamp = getFormattedTimestamp();
  if (!player?.username) return;
  seenPlayers.delete(player.username)
  const msg = `${timestamp}\n🔴 Игрок **\`${player.username.replace(/([*`~])/g, '\\$1')}\`** вышел.`;
  logChatEntry(msg);
  logToDiscordChatLog(`${msg}`);
});

const pendingRealnames = new Map();

let collectingBlock = false;
let blockBuffer = [];

bot.on('message', async (jsonMsg) => {
  const timestamp = getFormattedTimestamp();
  const text = jsonMsg.toString();
  const parsed = (parseFormattedMessage(jsonMsg?.json || jsonMsg) + '').replace(/§[xr]/gi, '');
  const colored = (parseColoredText(jsonMsg?.json || jsonMsg) + '').replace(/§[xr]/gi, '');
  if (parsed) console.log(colored);

  if (config.autoconsole && parsed.includes("Добро пожаловать!")) {
    bot.chat("/console");
  }

  if (text.startsWith("Не удалось подключить вас к серверу")) {
    try {
      await bot.chat("/games");

      setTimeout(() => {
        bot.clickWindow(21, 0, 0);
      }, 1500);
    } catch (err) {
      console.error(chalk.hex('#FF0000')('[Ошибка]: ', err));
    }
  }

  if (text === '---------------------------------') {
    if (!collectingBlock) {
      collectingBlock = true;
      blockBuffer = [];
    } else {
      collectingBlock = false;
      if (blockBuffer.length > 0) {
        const finalMessage = blockBuffer.join("\n");
        outputToDiscord(`\`\`\`\n${finalMessage}\n\`\`\``);
      }
    }
  } else if (collectingBlock) {
    blockBuffer.push(text);
  }

  const arrowIndex = parsed.lastIndexOf('⇨');

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
          pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [] });
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
    parsed.startsWith('[SS]') || parsed.includes('временно забанил IP-адрес') ||
    parsed.startsWith('>') || parsed.startsWith('〄 Объявление:') ||
    parsed.startsWith('『КОНСОЛЬ』');

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

    if (/^(❤ )?\[(ɢ|ʟ)\]/i.test(parsed)) {
      if (arrowIndex !== -1) {
        const leftPart = parsed.slice(0, arrowIndex).trim();
        const msgText = parsed.slice(arrowIndex + 1).replace(/^⇨\s*/, '').trim();
        let usernameRaw = leftPart.split(/\s+/).pop();

        if (usernameRaw.startsWith('~')) {
          const displayNick = usernameRaw.toLowerCase();
          if (nickMap.has(displayNick)) {
            usernameRaw = nickMap.get(displayNick);
          } else {
            if (!pendingRealnames.has(displayNick))
              pendingRealnames.set(displayNick, { logs: [], commands: [], answers: [] });
            pendingRealnames.get(displayNick).logs.push({ timestamp, msgText });
            pendingRealnames.get(displayNick).commands.push(msgText);
            requestRealName(usernameRaw);
            return;
          }
        }

        try {
          await processUserCommand(usernameRaw.toLowerCase(), msgText.replace(/§./g, '').trim());
        } catch (err) {
          console.error(
            chalk.bold.hex('#FF0000')('[Ошибка]') + ' ' +
            chalk.hex('#ff8282')('processUserCommand:', err)
          );
        }

        await logToDiscordChatLog(`${timestamp} :speech_balloon: **\`${usernameRaw}\`**\n\`\`\`\n${msgText}\n\`\`\``);
        return;
      }
    }

    await logToDiscordChatLog(`${timestamp}\n\`\`\`\n${parsed}\n\`\`\``);
  }

  const realnameMatch = text.match(/^~(.+?) is (\w+)/);
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
            chalk.bold.hex('#FF0000')('[Ошибка]') + ' ' +
            chalk.hex('#ff8282')('processUserCommand (pending cmds):', err)
          );
        }
      }

      for (const ans of data.answers) {
        if (awaitingAnswer && currentGame && ans.toLowerCase() === currentGame.answer.toLowerCase()) {
          giveGameReward(realNick);
        }
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
          await logToDiscordChatLog(`${log.timestamp} :speech_balloon: **\`Unknown Player\`**\n\`\`\`\n${log.msgText}\n\`\`\``);
        }

        pendingRealnames.delete(displayNick);
      }
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
        await outputToDiscord(`\`\`\`\nКоманда "${pendingDiscordRun.command}" не вернула сообщений.\n\`\`\``);
      }
      pendingDiscordRun = null;
      collectedRunOutput = [];
    }, 500);
  }

  const match = parsed?.match(/(?:[\s\S]*?)?(\S+)\s*⇨\s*(.*)/);
  if (match) {
    await handleChat(match[1].trim(), match[2].trim());
  }
});

bot.once('windowOpen', (window) => {
  const title = window.title?.value?.text?.value || 'Без названия';
  console.log(
    chalk.bold.hex('#FF70C3')('[GUI]') + ' ' +
    chalk.hex('#ffafde')('Окно открылось с названием:', title)
  );

  if (title.toLowerCase().includes('выбор')) {
    const slot = window.slots[21];
    if (slot) {
      bot.clickWindow(slot.slot, 0, 0);
      console.log(
        chalk.bold.hex('#FF70C3')('[GUI]') + ' ' +
        chalk.hex('#ffafde')(`Кликнул по слоту ${slot.slot} с предметом ${slot.name}`)
      );
    } else {
      console.log(
        chalk.bold.hex('#FF70C3')('[GUI]') + ' ' +
        chalk.hex('#ffafde')('Слот 21 пуст')
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

  const consoleCommands = ['blacklist', 'eco', 'cmd', 'mute', 'unmute', 'rape', 'exit', 'info', 'bcode', 'restart'];

  if (consoleCommands.some(cmd => lowered.startsWith(config.botprefix + cmd))) {
    await processUserCommand('CONSOLE', trimmed);
  } else if (trimmed.startsWith('menu.slot.')) {
    const slotStr = trimmed.split('.')[2];
    const slot = parseInt(slotStr, 10);
    if (isNaN(slot)) {
      console.log(chalk.hex('#FF0000')('Ошибка: неверный номер слота'));
      return;
    }
    if (!bot.currentWindow) {
      console.log(chalk.hex('#FF0000')('Ошибка: меню не открыто'));
      return;
    }
    try {
      await bot.clickWindow(slot, 0, 0);
      console.log(chalk.hex('#00FF00')(`Клик по слоту ${slot} выполнен`));
    } catch (err) {
      console.log(chalk.hex('#FF0000')('Ошибка при клике по слоту:', err.message));
    }
  } else if (trimmed.startsWith('/')) {
    bot.chat(trimmed);

  } else if (trimmed.startsWith('discord.send ')) {
    const msg = trimmed.slice("discord.send".length).trim();

    if (!msg) {
      console.log(chalk.hex('#7CB6FF')("Укажи текст для отправки."));
      return
    }

    try {
      await outputToDiscord(msg);
      console.log(chalk.hex('#7CB6FF')("Сообщение отправлено!"));
    } catch (err) {
      console.error(chalk.hex('#7CB6FF')("Ошибка при отправки:", err));
    }

  } else if (trimmed.startsWith('menu.close')) {
    if (bot.currentWindow) {
      bot.closeWindow(bot.currentWindow);
      console.log(chalk.hex('#00FF00')(`Меню закрыто`));
    } else {
      console.log(chalk.hex('#FF0000')('Ошибка: меню не открыто'));
    }

  } else if (trimmed.startsWith('menu.show')) {
    if (bot.currentWindow) {
      console.log(chalk.hex('#00FF00')(`Содержимое меню:`));
      bot.currentWindow.slots.forEach((item, index) => {
        if (item) {
          const idName = item.name;
          const rawName = item?.nbt?.value?.display?.value?.Name?.value;
          const displayName = rawName ? itemDisplayName(JSON.parse(rawName)) : idName;

          console.log(chalk.hex('#B4E781')(`[${index}] ${idName} x${item.count} (${displayName})`));
        }
      });

    } else {
      console.log(chalk.hex('#FF0000')('Ошибка: меню не открыто'));
    }

  } else {
    bot.chat(`${trimmed}`);
  }
});

bot.on('error', err => {
  outputToDiscord(err);
  console.error(chalk.hex('#FF0000')('[Ошибка]', err));
});
bot.on('end', (reason) => {
  console.log(
    chalk.bold.hex('#61EFFF')('[Бот]') + ' ' +
    chalk.hex('#acacac')('Вышел из игры | причина:', reason)
  );
  setTimeout(() => process.exit(1), 100);
});
