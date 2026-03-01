import chalk from 'chalk';
import fs from 'fs';
import chokidar from 'chokidar';
import yaml from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename1 = fileURLToPath(import.meta.url);
const __dirname1 = path.dirname(__filename1);

let config = {};

function loadConfig() {
    const configPath = path.join(__dirname1, 'config.yml');
    try {
        const file = fs.readFileSync(configPath, 'utf8');
        config = yaml.load(file) || {};
        console.log(
            chalk.bold.hex('#5fb857')('[ExamplePlugin]') + ' ' +
            chalk.hex('#00ff00')('Config loaded')
        );
    } catch (err) {
        console.error(
            chalk.bold.hex('#5fb857')('[ExamplePlugin]') + ' ' +
            chalk.hex('#ff4040')('Error loading config:', err)
        );
        config = {};
    }
}

loadConfig();

const configPath = path.join(__dirname1, 'config.yml');
fs.watchFile(configPath, () => {
    console.log(
        chalk.bold.hex('#5fb857')('[ExamplePlugin]') + ' ' +
        chalk.hex('#ffc23d')('Change detected, reloading config...')
    );
    loadConfig();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LANG_DIR = path.join(__dirname, 'language');
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
        console.log(chalk.hex('#dffd99')(`[ExamplePlugin] ${t('plugin.language.updated')}: ${lang}`));
    } catch (err) {
        console.error(chalk.hex('#fd99aa')(`[ExamplePlugin] ${t('plugin.language.failedreload')} ${lang}:`, err));
    }
});

export async function onEnable({ registerCommand, bot, outputToDiscord }) {

    console.log(chalk.hex('#ff9100')(`[ExamplePlugin] ${t('plugin.enabled')}`));

    registerCommand('hello', async ({ source, displayName }) => {
        if (source === 'mc') await bot.chat(`/m ${displayName} ${t('plugin.cmd.mchello', { name: displayName })}`)
        else await outputToDiscord(t('plugin.cmd.dchello', { name: displayName }));
    });
}

export async function onDisable() {
    console.log(chalk.hex('#ff9100')(`[ExamplePlugin] ${t('plugin.disabled')}`));
}