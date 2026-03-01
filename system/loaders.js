import fs from 'fs';
import yaml from 'js-yaml';
import chalk from 'chalk';
import chokidar from 'chokidar';
import path from 'path';

export let config = {};

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

loadConfig();

export function saveConfig() {
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

fs.watchFile('./settings/config.yml', () => {
  console.log(
    chalk.bold.hex('#5fb857')('[Config]') + ' ' +
    chalk.hex('#ffc23d')('Change detected, update...')
  );
  loadConfig();
});

const LANG_DIR = './language'
export let languages = {};

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

export function t(key, vars = {}) {
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