import { config, t, saveConfig } from './loaders.js';
import {
    bot, outputToDiscord, getRole, getRoles, getUserExtraPerms, checkBan, isBlacklisted, hasPermission, startTime, formatUptime, discordClient, discordOutput, sendEmbed, db, roles, isBanned,
    addToBlacklist, removeFromBlacklist, getBlacklist, grantPermission, revokePermission, banUser, unbanUser, getBalance, changeBalance, setBalance, getBotBalance, getSymbol, startBroadcast, stopBroadcast,
    resolveUserArg, userExists, shop, saveShop, savePurchases, purchases, codesCache, codesFile, seenPlayers, saveRoles, buildDatabaseEmbed, buildButtons
} from './main.js';
import { globals } from './globals.js';
import chalk from 'chalk';
import { exec } from "child_process";
import fs from 'fs';
import yaml from 'js-yaml';
import { loadPlugin, disablePlugin, reloadPlugin, plugins, enablePlugin } from './PluginManager.js';

const withdrawRequests = new Map();
const activeBlackjackGames = new Map();
let activeSpammer = null;
let spammerInterval = null;
const casinoCooldowns = new Map();
const bjCooldowns = new Map();

function isNearby(username, maxDistance = 10) {
    const player = bot.players[username];
    if (!player || !player.entity) return false;

    const distance = bot.entity.position.distanceTo(player.entity.position);
    return distance <= maxDistance;
}

export async function preCommandCheck({ cmd, parts, source, displayName, realUsername, isConsole }) {
    const trimmedCmd = cmd.toLowerCase();

    const discordBlockedCommands = config.discordBlockedCommands;
    const alwaysAllowed = config.alwaysAllowed;

    if (source === 'discord' && discordBlockedCommands.includes(trimmedCmd) &&
        !(trimmedCmd === 'balance' && parts[1]?.toLowerCase() === 'withdraw' && parts[2]?.toLowerCase() === 'requests')) {
        await outputToDiscord(t('bot.cmd.discordblocked', { prefix: config.botprefix, cmd: trimmedCmd }));
        return false;
    }

    if (await checkBan(realUsername)) return false;

    if (await isBlacklisted(realUsername)) {
        await bot.chat(`/m ${displayName} &c${t('bot.blacklisted')}`);
        return false;
    }

    if (displayName !== 'SYSTEM' && source === 'mc' && config.enable_isnearby && !isNearby(displayName, 10)) {
		await bot.chat(`/m ${displayName} ${t('bot.isnearby')}`);
		return false;
	}

    if (!alwaysAllowed.includes(trimmedCmd) && !isConsole) {
        if (!(await hasPermission(displayName, trimmedCmd))) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.noperm')} &e${config.botprefix}${trimmedCmd}!`);
            return false;
        }
    }

    if (config.testmode && source === 'mc') {
        const role = await getRole(displayName);
        if (role !== 'owner') {
            await bot.chat(`/m ${displayName} ${t('bot.testmode')}`);
            return false;
        }
    }

    return true;
}

export const commands = {
    help: async ({ source, displayName, originalSender }) => {
        const effectiveUsername = source === 'discord' ? originalSender : displayName;
        const roleName = await getRole(effectiveUsername);

        const rolesData = getRoles();
        const roleInfo = rolesData[roleName] || { cmds: [] };
        const baseCommands = roleInfo.cmds || [];
        const alwaysAllowed = config.alwaysAllowed;
        const extraPerms = await getUserExtraPerms(effectiveUsername);
        const allCommands = [...new Set([...baseCommands, ...extraPerms, ...alwaysAllowed])];

        const commandDescriptions = t('bot.cmd.descriptions') || {};

        if (source === 'discord') {
            const detailedList = Object.entries(commandDescriptions)
                .map(([cmd, desc]) => `${config.botprefix}${cmd} » ${desc}`)
                .join('\n');
            await outputToDiscord(detailedList);
        } else {
            const withPrefix = allCommands.map(c => config.botprefix + c);
            await bot.chat(`/m ${displayName} ${t('bot.cmd.availablecmds')} &e${withPrefix.join(', ')}`);
        }
    },
    info: async ({ source, displayName, parts }) => {
        const target = parts[1];

        if (!target) {
            const uptime = Date.now() - startTime;
            const formatted = formatUptime(uptime);
            const ip = bot._client?.socket?.remoteAddress || bot.options?.host || t('bot.unspecified');
            const port = bot._client?.socket?.remotePort || bot.options?.port || t('bot.unspecifed');
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
            return;
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
            return;
        }

        const roleData = roles[targetUser.role];
        const roleDisplay = roleData?.display || '???';
        const banned = await isBanned(targetUser.nickname);
        const bannedSymbol = banned ? '&a☑' : '&c☒';

        if (source === 'mc') {
            await bot.chat(`/m ${displayName} &f${roleDisplay} &f${targetUser.nickname} &8| &eID: &6${targetUser.id} &8| &2${t('db.balance')}: &6${targetUser.balance.toLocaleString('de-DE')}⛃ &8| ${t('bot.banned', { ban: bannedSymbol })}`);
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
    },
    msg: async ({ source, displayName, parts }) => {
        const msgText = parts.slice(1).join(' ').trim();
        if (!msgText) return;

        if (msgText.includes(config.botprefix)) {
            if (source === 'mc') {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}`);
            } else {
                await outputToDiscord(`${t('bot.cmd.msg.nocmds', { prefix: config.botprefix })}`);
            }
            return;
        }

        if (config.msg_hidename) {
            await bot.chat(`!${msgText}`);
        } else {
            await bot.chat(`!${t('bot.cmd.msg.from')} &a${displayName}: ${msgText}`);
        }

        if (source === 'discord') await outputToDiscord(`${t('bot.cmd.msg.dcsubmitted')}`);
        return;
    },
    run: async ({ source, displayName, parts }) => {
        const cmdToRun = parts.slice(1).join(' ').trim();
        const cmdLower = cmdToRun.toLowerCase();
        const bannedRunCommands = config.bannedRunCommands;

        if (!cmdToRun) return;

        if (cmdToRun.includes(config.botprefix)) {
            if (source === 'mc') {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
            } else {
                await outputToDiscord(`${t('bot.cmd.run.nocmds', { prefix: config.botprefix })}`);
            }
            return;
        }

        if (bannedRunCommands.some(b => cmdLower.startsWith(b))) {
            if (source === 'mc') {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.run.blockedcmd')}`);
            } else {
                await outputToDiscord(`${t('bot.cmd.run.blockedcmd')}`);
            }
            return;
        }

        await bot.chat(`/${cmdToRun}`);

        globals.pendingDiscordRun = { command: cmdToRun, source };
        globals.collectedRunOutput = [];

        if (globals.runTimeout) clearTimeout(globals.runTimeout);
        globals.runTimeout = setTimeout(async () => {
            if (globals.pendingDiscordRun && globals.collectedRunOutput.length > 0) {
                const combined = globals.collectedRunOutput.join('\n');
                if (globals.pendingDiscordRun.source === 'discord') {
                    await outputToDiscord(`${combined}`);
                }
            } else {
                if (globals.pendingDiscordRun?.source === 'discord') {
                    await discordOutput.send({ embeds: [sendEmbed(`⚠️ ${t('bot.cmd.run.executing')}`, ``, { color: 0xf1c40f, footer: 'WARN', fields: [{ name: `${t('bot.error_occurred')}`, value: `\`\`\`${t('bot.cmd.run.nomsg', { cmd: globals.pendingDiscordRun.command })}\`\`\``, inline: true }], timestamp: true })] });
                }
            }
            globals.pendingDiscordRun = null;
            globals.collectedRunOutput = [];
        }, 500);

        return;
    },
    exit: async ({ source }) => {
        await bot.chat(`/me &8[&#FF0000⏻&8] ${t('bot.cmd.exit.exitbot')}`);
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
        return;
    },
    restart: async ({ source }) => {
        if (process.env.pm_id !== undefined) {
            await bot.chat(`/me &8[&#00FF00⟳&8] ${t('bot.cmd.restart.restarting')}`);
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
        return;
    },
    blacklist: async ({ source, displayName, parts, isConsole }) => {
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
            return;
        }

        if (!target) {
            if (source === 'mc')
                await bot.chat(`/m ${displayName} ${t('bot.cmd.blacklist.usage_sub', { prefix: config.botprefix, subcmd })}`);
            else
                await outputToDiscord(`${t('bot.cmd.blacklist.usage_subdc', { prefix: config.botprefix, subcmd })}`);
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
            const roleName = role === 'owner' ? t('bot.cmd.ban.owner') : t('bot.cmd.ban.moder');
            if (source === 'mc')
                await bot.chat(`/m ${displayName} &c${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
            else
                await outputToDiscord(`${t('bot.cmd.blacklist.cannot_manage', { role: roleName })}`);
            return;
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

        return;
    },
    ban: async ({ source, displayName, parts, isConsole }) => {
        const target = parts[1];
        const timeStr = parts[2];
        const reason = parts.slice(3).join(' ') || t('bot.cmd.ban.noreason');

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
            const roleName = role === 'owner' ? t('bot.cmd.ban.owner') : t('bot.cmd.ban.moder');
            if (source === 'mc') await bot.chat(`/m ${displayName} &c${t('bot.cmd.ban.cannot_ban', { role: roleName })}`);
            else await outputToDiscord(t('bot.cmd.ban.cannot_ban', { role: roleName }))
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
        return;
    },
    unban: async ({ source, displayName, parts }) => {
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

        return;
    },
    cmd: async ({ source, displayName, parts }) => {
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

        return;
    },
    feedback: async ({ displayName, parts }) => {
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

            feedbackData[displayName] = feedbackText;
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

        return;
    },
    rape: async ({ source, displayName, parts }) => {
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

        return;
    },
    balance: async ({ source, displayName, parts }) => {
        const arg = parts[1];

        if (arg?.toLowerCase() === 'top') {
            db.all('SELECT nickname, balance FROM users ORDER BY balance DESC LIMIT 5', [], async (err, rows) => {
                if (err || !rows.length) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.top_empty')}`);
                    return;
                }

                const topPlayers = rows
                    .map((r, i) => `&d${i + 1}. &a${r.nickname} &7- &6${r.balance.toLocaleString('de-DE')}⛃`)
                    .join(' &8| ');

                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.top_list', { list: topPlayers })}`);
            });
            return;
        }

        if (arg && arg.toLowerCase() !== 'withdraw' && arg !== displayName) {
            const targetUser = await resolveUserArg(arg);
            if (!targetUser || !(await userExists(targetUser))) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.not_found')}`);
                return;
            }

            const targetBalance = await getBalance(targetUser);
            await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.target', { target: targetUser, balance: targetBalance.toLocaleString('de-DE') })}`);
            return;
        }

        if (arg?.toLowerCase() === 'withdraw') {

            const sub = parts[2]?.toLowerCase();

            if (config.disablewithdraw) return await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_disabled')}`)

            if (sub === 'confirm') {
                const targetUser = parts[3];
                if (!targetUser) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_selectuser')}`);
                    return;
                }

                const role = await getRole(displayName);
                if (role !== 'owner') {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_confirmonlyowner')}`);
                    return;
                }

                const request = withdrawRequests.get(targetUser);
                if (!request) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_norequest')}`);
                    return;
                }

                const amount = request.amount;

                if (amount < config.minwithdraw) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_min', { min: config.minwithdraw })}`);
                    return;
                }

                let botBalance;
                try {
                    botBalance = await getBotBalance();
                } catch (err) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.errorbotbalance')}`);
                    return;
                }

                if (botBalance < amount) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.nobotmoney', { botBalance })}`);
                    return;
                }

                await changeBalance(targetUser, -amount);
                bot.chat(`/pay ${targetUser} ${amount}`);

                withdrawRequests.delete(targetUser);

                await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.withdraw_confirmed', { amount: amount.toLocaleString('de-DE'), targetUser, username: displayName })}`);
                return;
            }

            if (sub === 'decline') {
                const targetUser = parts[3];
                if (!targetUser) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_selectuser')}`);
                    return;
                }

                const role = await getRole(displayName);
                if (role !== 'owner') {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_declinemonlyowner')}`);
                    return;
                }

                const request = withdrawRequests.get(targetUser);
                if (!request) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_norequest')}`);
                    return;
                }

                withdrawRequests.delete(targetUser);

                await bot.chat(`/me &8[&6⛃&8] ${t('bot.cmd.balance.withdraw_declined', { amount: request.amount.toLocaleString('de-DE'), targetUser, username: displayName })}`);
                return;
            }

            if (sub === 'requests') {

                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_requestsonlydiscord')}`);

                if (!withdrawRequests.size) {
                    await outputToDiscord(`${t('bot.cmd.balance.withdraw_noactiverequests')}`);
                    return;
                }

                let discordList = [];

                for (const [nick, data] of withdrawRequests.entries()) {
                    const formattedAmount = data.amount.toLocaleString('de-DE');
                    discordList.push(`• ${nick} - ${formattedAmount}⛃`);
                }

                await outputToDiscord(
                    `${t('bot.cmd.balance.withdraw_activerequests')}:\n` +
                    discordList.join('\n')
                );

                return;
            }

            const amount = parseInt(parts[2], 10);
            if (isNaN(amount) || amount <= 0) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_invalid')}`);
                return;
            }

            if (amount < config.minwithdraw) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_min', { min: config.minwithdraw })}`);
                return;
            }

            const playerCoins = await getBalance(displayName);
            if (playerCoins < amount) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_nomoney', { amount: amount.toLocaleString('de-DE') })}`);
                return;
            }

            let botBalance;
            try {
                botBalance = await getBotBalance();
            } catch (err) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.errorbotbalance')}`);
                return;
            }

            if (botBalance < amount) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.nobotmoney', { botBalance })}`);
                return;
            }

            if (amount >= config.minwithdrawconfirm) {

                if (withdrawRequests.has(displayName)) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_activerequest')}`);
                    return;
                }

                withdrawRequests.set(displayName, {
                    amount,
                    createdAt: Date.now()
                });

                await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_requestsended', { amount: amount.toLocaleString('de-DE') })}`);
                await outputToDiscord(`${t('bot.cmd.balance.withdraw_notifysendrequest', { username: displayName, amount: amount.toLocaleString('de-DE'), prefix: config.botprefix })}`)
                return;
            }

            await changeBalance(displayName, -amount);
            bot.chat(`/pay ${displayName} ${amount}`);

            await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.withdraw_done', { amount: amount.toLocaleString('de-DE') })}`);
            await outputToDiscord(`${t('bot.cmd.balance.withdraw_notifydone', { username: displayName, amount: amount.toLocaleString('de-DE') })}`)
            return;
        }
        const balance = await getBalance(displayName);
        await bot.chat(`/m ${displayName} ${t('bot.cmd.balance.your', { balance: balance.toLocaleString('de-DE') })}`);
        return;
    },
    eco: async ({ source, displayName, parts }) => {
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

        return;
    },
    pay: async ({ displayName, parts }) => {
        const target = parts[1];
        const amount = parseInt(parts[2], 10);

        if (!target || isNaN(amount) || amount <= 0) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.usage', { prefix: config.botprefix })}`);
            return;
        }

        const targetUser = await resolveUserArg(target);
        if (!targetUser || !(await userExists(targetUser))) {
            await bot.chat(`/m ${displayName} ${t('bot.usernotfound', { user: target })}`);
            return;
        }

        if (targetUser === displayName) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.self')}`);
            return;
        }

        const senderBalance = await getBalance(displayName);
        if (senderBalance < amount) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.pay.no_money', { balance: senderBalance })}`);
            return;
        }

        await changeBalance(displayName, -amount);
        await changeBalance(targetUser, amount);

        await bot.chat(`/me &8[&#00FF00⛃&8] ${t('bot.cmd.pay.success', { username: displayName, target: targetUser, amount: amount.toLocaleString('de-DE') })}`);
        return;
    },
    shop: async ({ displayName, parts }) => {
        const subcmd = parts[1]?.toLowerCase();
        const itemId = parts[2]?.toLowerCase();

        if (!shop || !Array.isArray(shop)) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.unavailable')}`);
            return;
        }

        if (!subcmd) {
            const list = shop.map(i => {
                const pricePart = `&8(&6${i.price.toLocaleString('de-DE')}⛃&8)`;
                if (typeof i.stock === 'number') {
                    if (i.stock <= 0) {
                        return `&7&m${i.name}&r &8[&c✘&8]`;
                    }
                    return `&e${i.name} ${pricePart} &8[&6${i.stock}⏹&8]`;
                }
                return `&e${i.name} ${pricePart}`;
            }).join('&e, ');
            await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.list', { list })}`);
            return;
        }

        if (subcmd === 'buy') {
            if (!itemId) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.usage', { prefix: config.botprefix })}`);
                return;
            }

            const amountArg = parts[3];
            let amount = 1;

            if (amountArg && Number.isFinite(Number(amountArg))) {
                amount = Math.max(1, parseInt(amountArg));
            }

            const item = shop.find(i =>
                i.id.toLowerCase() === itemId ||
                i.name.toLowerCase() === itemId
            );

            if (!item) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.not_found', { item: itemId })}`);
                return;
            }

            const itemKey = item.id.toLowerCase();

            if (typeof item.stock === 'number') {

                if (item.stock <= 0) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.soldout')}`);
                    return;
                }

                if (amount > item.stock) {
                    await bot.chat(`/m ${displayName} ❌ ${t('bot.cmd.shop.availableonly', { item: item.stock })}`);
                    return;
                }
            }

            if (item.oneTime) {
                amount = 1;

                if (!purchases[displayName]) purchases[displayName] = [];

                if (purchases[displayName].includes(itemKey)) {
                    await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.already_bought', { item: item.name })}`);
                    return;
                }
            }

            const totalPrice = item.price * amount;
            const bal = getBalance(displayName);

            if (bal < totalPrice) {
                await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.not_enough', {
                    item: item.name,
                    price: totalPrice.toLocaleString('de-DE')
                })}`);
                return;
            }

            changeBalance(displayName, -totalPrice);

            if (typeof item.stock === 'number') {
                item.stock -= amount;
                saveShop();
            }

            if (item.oneTime) {
                if (!purchases[displayName]) purchases[displayName] = [];
                purchases[displayName].push(itemKey);
                savePurchases();
            }

            if (item.command) {
                for (let i = 0; i < amount; i++) {
                    const commandToRun = item.command.replace('{player}', displayName);
                    await bot.chat(commandToRun);
                }
            }

            await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.success', { item: item.name, price: totalPrice.toLocaleString('de-DE'), amount })}`);

            return;
        }

        await bot.chat(`/m ${displayName} ${t('bot.cmd.shop.invalid_sub', { prefix: config.botprefix })}`);
        return;
    },
    code: async ({ displayName, parts }) => {
        const codeName = parts[1]?.toLowerCase();

        if (!codeName) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.code.no_code', { prefix: config.botprefix })}`);
            return;
        }

        const codeObj = codesCache[codeName];
        if (!codeObj) {
            await bot.chat(`/m ${displayName} ${t('bot.cmd.code.not_found', { code: codeName })}`);
            return;
        }

        const alreadyUsed = codeObj.usedBy?.includes(displayName);
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
            changeBalance(displayName, amount);
            await bot.chat(`/m ${displayName} &8[&#00ff00🛈&8] ${t('bot.cmd.code.activated_money', { amount: amount.toLocaleString('de-DE') })}`);
        }

        if (codeObj.action?.type === 'command') {
            const c = codeObj.action.command.replace('{player}', originalCasedUsername);
            bot.chat(c);
        }

        if (!codeObj.usedBy) codeObj.usedBy = [];
        codeObj.usedBy.push(displayName);
        codeObj.usedTotal = (codeObj.usedTotal || 0) + 1;
        fs.writeFileSync(codesFile, yaml.dump(codesCache, { indent: 2, lineWidth: -1 }), 'utf8');
        return;
    },
    bcode: async ({ displayName, parts }) => {
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
            case 'command': rewardInfo = `${t('bot.cmd.code.botcmd')}`; break;
            default: rewardInfo = `${t('bot.cmd.code.unknown')}`;
        }

        await bot.chat(`/me ${t('bot.cmd.bcode.available', { code: codeName, remaining: Math.max(0, remaining), prefix: config.botprefix, reward: rewardInfo })}`);
        return;
    },
    list: ({ source }) => {
        if (source === 'mc') return;
        const players = Object.keys(bot.players);
        const online = players.length;

        if (online === 0) {
            outputToDiscord(`${t('bot.cmd.list.none')}`);
        } else {
            outputToDiscord(`${t('bot.cmd.list.online', { count: online, players: players.join(', ') })}`);
        }
        return;
    },
    spammer: ({ source, parts }) => {
        if (source === 'mc') return;

        const args = parts.slice(1);

        if (args[0] === 'stop') {
            if (spammerInterval) {
                clearInterval(spammerInterval);
                spammerInterval = null;
                activeSpammer = null;
                outputToDiscord(`${t('bot.cmd.spammer.stopped')}`);
            } else {
                outputToDiscord(`${t('bot.cmd.spammer.not_running')}`);
            }
            return;
        }

        if (spammerInterval) {
            outputToDiscord(`${t('bot.cmd.spammer.already_running')}`);
            return;
        }

        if (args.length < 2) {
            outputToDiscord(`${t('bot.cmd.spammer.usage', { prefix: config.botprefix })}`);
            return;
        }

        const cooldown = parseInt(args[args.length - 1], 10);
        if (isNaN(cooldown) || cooldown <= 0) {
            outputToDiscord(`${t('bot.cmd.spammer.invalid_cooldown')}`);
            return;
        }

        const commandParts = args.slice(0, -1);
        const allIndex = commandParts.indexOf('all');

        let players = [];
        let cmdTemplate = [...commandParts];

        if (allIndex !== -1) {
            players = [...seenPlayers].filter(p => p !== bot.username);

            if (!players.length) {
                outputToDiscord(`${t('bot.cmd.spammer.no_players')}`);
                return;
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
        return;
    },
    config: async ({ source, parts, languages }) => {
        if (source === 'mc') return;
        const args = parts.slice(1);

        const paramMeta = {
            msg_hidename: t('bot.cmd.config.msg_hidename', { prefix: config.botprefix }),
            botprefix: t('bot.cmd.config.botprefix'),
            autoconsole: t('bot.cmd.config.autoconsole'),
            testmode: t('bot.cmd.config.testmode'),
            lang: t('bot.cmd.config.lang'),
            minwithdraw: t('bot.cmd.config.minwithdraw'),
            mindeposit: t('bot.cmd.config.mindeposit'),
            minbet: t('bot.cmd.config.minbet'),
            minwithdrawconfirm: t('bot.cmd.config.minwithdrawconfirm'),
            killswitch: t('bot.cmd.config.killswitch'),
            disablewithdraw: t('bot.cmd.config.disablewithdraw'),
			casinocooldown: t('bot.cmd.config.casinocooldown'),
			bjcooldown: t('bot.cmd.config.bjcooldown'),
			enable_isnearby: t('bot.cmd.config.enable_isnearby')
        };

        const hiddenParams = ['host', 'port', 'botnick', 'bannedRunCommands', 'discordBlockedCommands', 'alwaysAllowed', 'discord', 'ai', 'gui', 'chat', 'mcversion'];

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
            return;
        }

        const param = args[0];
        const value = args[1];

        if (hiddenParams.includes(param)) {
            outputToDiscord(`${t('bot.cmd.config.cannot_change', { param })}`);
            return;
        }

        if (!(param in config)) {
            outputToDiscord(`${t('bot.cmd.config.unknown_param', { param })}`);
            return;
        }

        let newValue;

        if (param === 'lang') {
            const availableLangs = Object.keys(languages);
            if (!availableLangs.includes(value)) {
                outputToDiscord(`${t('bot.cmd.config.invalid_value', { value })}. ${t('bot.cmd.config.availablelangs')} ${availableLangs.join(', ')}`);
                return;
            }
            newValue = value;
        } else if (typeof config[param] === "boolean") {
            if (!["true", "false"].includes(value.toLowerCase())) {
                outputToDiscord(`${t('bot.cmd.config.boolean_usage', { param })}`);
                return;
            }
            newValue = value.toLowerCase() === "true";
        } else if (typeof config[param] === "number") {
            newValue = parseInt(value, 10);
            if (isNaN(newValue)) {
                outputToDiscord(`${t('bot.cmd.config.invalid_value', { value })}`);
                return;
            }
        } else {
            newValue = value;
        }

        config[param] = newValue;
        saveConfig();

        const displayValue = (typeof newValue === "boolean") ? (newValue ? t('bot.yes') : t('bot.no')) : newValue;
        const prettyName = paramMeta[param] || param;

        outputToDiscord(`${t('bot.cmd.config.updated', { param: prettyName, value: displayValue })}`);
        return;
    },
    role: async ({ displayName, source, parts }) => {
        const args = parts.slice(1).map(a => a?.trim()).filter(Boolean);
        const sub = args[0];
        const roles = getRoles();

        if (!sub) {
            if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage', { prefix: config.botprefix })}`);
            else await outputToDiscord(t('bot.cmd.role.usagedc', { prefix: config.botprefix }));
            return;
        }

        if (sub === 'add') {
            const roleName = args[1];
            const display = args.slice(2).join(' ');

            if (!roleName || !display) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_add', { prefix: config.botprefix })}`);
                else await outputToDiscord(t('bot.cmd.role.usage_adddc', { prefix: config.botprefix }));
                return;
            }

            if (roles[roleName]) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.exists', { role: roleName })}`);
                else await outputToDiscord(t('bot.cmd.role.existsdc', { role: roleName }));
                return;
            }

            roles[roleName] = { display, cmds: [] };
            saveRoles();

            if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.created', { role: roleName })}`);
            else await outputToDiscord(t('bot.cmd.role.createddc', { role: roleName }));
            return;
        }

        if (sub === 'remove') {
            const roleName = args[1];

            if (!roleName || !roles[roleName]) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.notfound', { role: roleName })}`);
                else await outputToDiscord(t('bot.cmd.role.notfounddc', { role: roleName }));
                return;
            }

            delete roles[roleName];
            saveRoles();

            db.run('UPDATE users SET role = "user" WHERE role = ?', [roleName]);

            if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.removed', { role: roleName })}`);
            else await outputToDiscord(t('bot.cmd.role.removeddc', { role: roleName }));
            return;
        }

        if (sub === 'set') {
            const targetArg = args[1];
            const roleName = args[2];

            if (!targetArg || !roles[roleName]) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_set', { prefix: config.botprefix })}`);
                else await outputToDiscord(t('bot.cmd.role.usage_setdc', { prefix: config.botprefix }));
                return;
            }

            const nickname = await resolveUserArg(targetArg);
            if (!nickname) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.usernotfounddc', { user: targetArg })}`);
                else await outputToDiscord(t('bot.usernotfounddcdc', { user: targetArg }));
                return;
            }

            db.run('UPDATE users SET role = ? WHERE nickname = ?', [roleName, nickname]);

            const roleData = roles[roleName];
            const roleDisplay = roleData?.display || '&7???';

            await bot.chat(`/me &8[&#439FFF🛡&8] ${t('bot.cmd.role.assigned', { by: displayName, user: nickname, role: roleDisplay })}`);
            if (source === 'discord') await outputToDiscord(t('bot.cmd.role.assigneddc', { user: nickname, role: roleName }));
            return;
        }

        if (sub === 'cmd') {
            const action = args[1];
            const roleName = args[2];
            const command = args[3]?.replace(config.botprefix, '');

            if (!['add', 'remove'].includes(action) || !roles[roleName] || !command) {
                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.usage_cmd', { prefix: config.botprefix })}`);
                else await outputToDiscord(t('bot.cmd.role.usage_cmddc', { prefix: config.botprefix }));
                return;
            }

            const cmds = roles[roleName].cmds ?? [];

            if (action === 'add') {
                if (!cmds.includes(command)) cmds.push(command);
                roles[roleName].cmds = cmds;
                saveRoles();

                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.cmd_added', { command, role: roleName })}`);
                else await outputToDiscord(t('bot.cmd.role.cmd_addeddc', { command, role: roleName }));
                return;
            }

            if (action === 'remove') {
                roles[roleName].cmds = cmds.filter(c => c !== command);
                saveRoles();

                if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.cmd_removed', { command, role: roleName })}`);
                else await outputToDiscord(t('bot.cmd.role.cmd_removeddc', { command, role: roleName }));
                return;
            }
        }

        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('bot.cmd.role.unknown_sub')}`);
        else await outputToDiscord(t('bot.cmd.role.unknown_subdc'));
        return;
    },
    database: async ({ }) => {
        db.all('SELECT id, nickname, role, balance FROM users', [], async (err, rows) => {
            if (err) {
                outputToDiscord(`${t('db.readerror')}`);
                return;
            }

            globals.cachedDatabaseRows.length = 0;
            globals.cachedDatabaseRows.push(...rows);

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

        return;
    },
    casino: async ({ displayName, parts }) => {
        const args = parts.slice(1);
        const sub = args[0];

        if (sub !== 'bet') {
            bot.chat(`/m ${displayName} ${t('bot.cmd.casino.usage', { prefix: config.botprefix })}`);
            return;
        }

        const bet = parseInt(args[1]);
        if (!bet || bet <= 0) {
            bot.chat(`/m ${displayName} ${t('bot.cmd.casino.zerobet')}`);
            return;
        }
        if (bet < config.minbet) {
            bot.chat(`/m ${displayName} ${t('bot.cmd.casino.minbet')}`);
            return;
        }

        const balance = await getBalance(displayName);
        if (bet > balance) {
            bot.chat(`/m ${displayName} ${t('bot.cmd.casino.nomoney')}`);
            return;
        }

        const now = Date.now();
        const lastCall = casinoCooldowns.get(displayName) || 0;
        if (now - lastCall < config.casinocooldown) {
            await bot.chat(`/m ${displayName} &c${t('bot.cooldown')}`);
            return;
        }
        casinoCooldowns.set(displayName, now);

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

        return;
    },
    bj: async ({ displayName, parts }) => {
        const args = parts.slice(1);
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
            if (!bet || bet <= 0) {
                bot.chat(`/m ${displayName} ${t('bot.cmd.casino.zerobet')}`);
                return;
            }
            const balance = await getBalance(displayName);
            if (bet > balance) {
                bot.chat(`/m ${displayName} ${t('bot.cmd.casino.nomoney')}`);
                return;
            }

            const now = Date.now();
            const lastCall = bjCooldowns.get(displayName) || 0;
            if (now - lastCall < config.bjcooldown) {
                await bot.chat(`/m ${displayName} &c${t('bot.cooldown')}`);
                return;
            }
            bjCooldowns.set(displayName, now);

            await changeBalance(displayName, -bet);
            const playerHand = [drawCard(), drawCard()];
            const dealerHand = [drawCard(), drawCard()];

            activeBlackjackGames.set(displayName, { bet, playerHand, dealerHand, status: 'playing' });

            const total = calculateTotal(playerHand);
            bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.yourcards')} &b${playerHand.join(', ')} &8(&9=${total}&8) &8| ${t('bot.cmd.casino.blackjack.dealercard')} &b${dealerHand[0]} &8| ${t('bot.cmd.casino.blackjack.usehitorstand', { prefix: config.botprefix })}`);
            return;
        }

        if (bjSub === 'hit') {
            const game = activeBlackjackGames.get(displayName);
            if (!game || game.status !== 'playing') {
                bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.noactivegame')}`);
                return;
            }

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
            return;
        }

        if (bjSub === 'stand') {
            const game = activeBlackjackGames.get(displayName);
            if (!game || game.status !== 'playing') {
                bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.noactivegame')}`);
                return;
            }

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
            return;
        }

        bot.chat(`/m ${displayName} ${t('bot.cmd.casino.blackjack.usage', { prefix: config.botprefix })}`);
        return;
    },
    broadcast: async ({ source, parts }) => {

        if (source === 'mc') return;

        const sub = parts[1]?.toLowerCase();

        if (sub === 'stop') {
            stopBroadcast();
            await outputToDiscord(t('bot.cmd.broadcast.stopped'));
            return;
        }

        if (parts.length < 3) {
            await outputToDiscord(t('bot.cmd.broadcast.usage', { prefix: config.botprefix }));
            return;
        }

        const symbolInput = parts[1];
        const symbol = getSymbol(symbolInput);

        let interval = null;
        const lastArg = parts[parts.length - 1];

        const parsed = Number(lastArg);

        if (Number.isFinite(parsed) && parsed > 0) {
            interval = parsed;
            parts.pop();
        }

        const text = parts.slice(2).join(' ');

        startBroadcast(symbol, text, interval);

        await outputToDiscord(t('bot.cmd.broadcast.started', { symbol: symbol.replace(/&[a-f0-9]/gi, ''), interval: interval ?? t('bot.cmd.broadcast.norepeat') }));

        return;
    },
    plugin: async ({ source, parts }) => {
        
        if (source === 'mc') return;

        const subcmd = parts[1]?.toLowerCase();
        const pluginName = parts[2];

        if (!subcmd || !pluginName) {
            await outputToDiscord(t('bot.cmd.plugin.usage', { prefix: config.botprefix }));
            return;
        }

        try {
            switch (subcmd) {
                case 'enable':
                    if (plugins.has(pluginName)) {
                        const plugin = plugins.get(pluginName);
                        if (!plugin.active) {
                            await enablePlugin(pluginName);
                        }
                        await outputToDiscord(t('bot.cmd.plugin.enabled', { plugin: pluginName }));
                    } else {
                        await loadPlugin(pluginName);
                        await outputToDiscord(t('bot.cmd.plugin.loadedandenabled', { plugin: pluginName }));
                    }
                    break;

                case 'disable':
                    if (!plugins.has(pluginName)) {
                        await outputToDiscord(t('bot.cmd.plugin.notfound', { plugin: pluginName }));
                        break;
                    }
                    await disablePlugin(pluginName);
                    await outputToDiscord(t('bot.cmd.plugin.disabled', { plugin: pluginName }));
                    break;

                case 'reload':
                    if (!plugins.has(pluginName)) {
                        await outputToDiscord(t('bot.cmd.plugin.notfound', { plugin: pluginName }));
                        break;
                    }
                    await reloadPlugin(pluginName, { outputToDiscord, commands });
                    await outputToDiscord(t('bot.cmd.plugin.reloaded', { plugin: pluginName }));
                    break;

                case 'info':
                    if (!plugins.has(pluginName)) {
                        await outputToDiscord(t('bot.cmd.plugin.notfound', { plugin: pluginName }));
                        break;
                    }

                    const plugin = plugins.get(pluginName);
                    const manifest = plugin.manifest;
                    const infoMsg = `${t('bot.cmd.plugin.info', { plugin: manifest.display || pluginName, version: manifest.version || t('bot.cmd.plugin.noversion'), author: manifest.author || t('bot.cmd.plugin.noauthor'), desc: manifest.description || t('bot.cmd.plugin.nodesc'), active: plugin.active ? t('bot.yes') : t('bot.no'), cmds: plugin.commands.length ? plugin.commands.join(', ') : t('bot.no') })}`
                    await outputToDiscord(`${infoMsg}`);
                    return;

                default:
                    await outputToDiscord(t('bot.cmd.plugin.invalidsubcmd'));
                    break;
            }
        } catch (err) {
            console.error(chalk.hex('#ad0e0e')(`[PluginManager] ` + (chalk.hex('#ff8181')(`${t('bot.cmd.plugin.pluginerror')} ${pluginName}: `) + (chalk.hex('#cc3a3a')(`${err}`)))));
            await outputToDiscord(`${t('bot.cmd.plugin.error')}`);
        }
    },
    plugins: async ({ source }) => {

        if (source === 'mc') return;

        const activePlugins = Array.from(plugins.values()).filter(p => p.active);

        if (activePlugins.length === 0) {
            await outputToDiscord(t('bot.cmd.plugins.noactive'));
            return;
        }

        const pluginList = activePlugins
            .map(p => p.manifest.display || p.name)
            .join(', ');

        const msg = `${t('bot.cmd.plugins.plugins')} (${activePlugins.length}):\n- ${pluginList}`;

        await outputToDiscord(msg);
    }
}