import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import * as botModule from '../main.js';
import chalk from 'chalk';

export const plugins = new Map();
export const pluginCommands = {};

export async function loadPlugin(name) {
  const pluginFolder = path.join('./plugins', name);

  if (!fs.existsSync(pluginFolder)) {
    throw new Error(`[PluginManager] Plugin folder "${name}" not found`);
  }

  const manifestPath = path.join(pluginFolder, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[PluginManager] manifest.json not found in "${name}"`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!manifest.main) {
    throw new Error(`[PluginManager] manifest.json missing "main" field in "${name}"`);
  }

  const mainFilePath = path.join(pluginFolder, manifest.main);
  if (!fs.existsSync(mainFilePath)) {
    throw new Error(`[PluginManager] Main file "${manifest.main}" not found in "${name}"`);
  }

  const moduleURL = pathToFileURL(mainFilePath).href;
  const module = await import(`${moduleURL}?update=${Date.now()}`);

  const pluginData = {
    name,
    module,
    manifest,
    commands: [],
    listeners: [],
    active: true
  };

  function registerCommand(cmdName, handler) {
    pluginCommands[cmdName] = handler;
    pluginData.commands.push(cmdName);
  }

  function registerListener(event, handler) {
    botModule.bot.on(event, handler);
    pluginData.listeners.push({ event, handler });
  }

  if (module.onEnable) {
    try {
      await module.onEnable({ registerCommand, registerListener, ...botModule });
    } catch (err) {
      console.error(`[PluginManager] Error in onEnable | Plugin "${name}":`, err);
    }
  }

  plugins.set(name, pluginData);

  return pluginData;
}

export async function disablePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin || !plugin.active) return false;

  if (plugin.module.onDisable) await plugin.module.onDisable();

  for (const cmd of plugin.commands) {
    delete pluginCommands[cmd];
  }

  plugin.active = false;

  for (const { event, handler } of plugin.listeners) {
    botModule.bot.off(event, handler);
  }

  plugin.listeners = [];

  return true;
}

export async function enablePlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin || plugin.active) return false;

  if (plugin.module.onEnable) {
    await plugin.module.onEnable({
      registerCommand: (cmdName, handler) => {
        pluginCommands[cmdName] = handler;
        plugin.commands.push(cmdName);
      },
      registerListener: (event, handler) => {
        botModule.bot.on(event, handler);
        plugin.listeners.push({ event, handler });
      },
      ...botModule
    });
  }

  plugin.active = true;
  return true;
}

export async function reloadPlugin(name) {
  const plugin = plugins.get(name);
  if (!plugin) throw new Error(`[PluginManager] Plugin "${name}" not loaded`);

  await disablePlugin(name);
  plugins.delete(name);

  return await loadPlugin(name);
}

export async function loadAllPlugins() {
  const pluginDir = './plugins';
  if (!fs.existsSync(pluginDir)) return;

  const pluginFolders = fs.readdirSync(pluginDir, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const name of pluginFolders) {
    try {
      const pluginData = await loadPlugin(name);
      console.log(chalk.hex('#3ad34e')(`[PluginManager] ` + (chalk.hex('#baffb8')(`Loaded and enabled plugin: `)) + (chalk.hex('#7aff76')(`${pluginData.manifest.display || name}`))));
    } catch (err) {
      console.error(chalk.hex('#ad0e0e')(`[PluginManager] ` + (chalk.hex('#ff8181')(`Failed to load plugin "${name}": `) + (chalk.hex('#cc3a3a')(`${err.message}`)))));
    }
  }
}