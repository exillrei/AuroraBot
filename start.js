import readline from 'readline';
import { execSync, spawn } from 'child_process';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { miniMessage } from './system/minimessage.js';

const ROOT = path.resolve(process.cwd());

const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function showHeader() {

  console.log(
    miniMessage('<gradient:#7C00FF:#D0A3FF> █████╗ ██╗   ██╗██████╗  ██████╗ ██████╗  █████╗ ██████╗  ██████╗ ████████╗</gradient>') +
    ('\n') +
    miniMessage('<gradient:#7C00FF:#D0A3FF>██╔══██╗██║   ██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝</gradient>') +
    ('\n') +
    miniMessage('<gradient:#7C00FF:#D0A3FF>███████║██║   ██║██████╔╝██║   ██║██████╔╝███████║██████╔╝██║   ██║   ██║   </gradient>') +
    ('\n') +
    miniMessage('<gradient:#7C00FF:#D0A3FF>██╔══██║██║   ██║██╔══██╗██║   ██║██╔══██╗██╔══██║██╔══██╗██║   ██║   ██║   </gradient>') +
    ('\n') +
    miniMessage('<gradient:#7C00FF:#D0A3FF>██║  ██║╚██████╔╝██║  ██║╚██████╔╝██║  ██║██║  ██║██████╔╝╚██████╔╝   ██║   </gradient>') +
    ('\n') +
    miniMessage('<gradient:#7C00FF:#D0A3FF>╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝  ╚═════╝    ╚═╝   </gradient>') +
    ('\n')
  )

  console.log(
    chalk.hex('#5795FF')('Creator: ') +
    chalk.hex('#BCF9FF')('exillrei')
  );
  console.log(
    chalk.hex('#5795FF')('Version: ') +
    chalk.hex('#BCF9FF')(pkg.version)
  );

  separator();
}

function separator() {
  console.log(chalk.gray('\n====================================\n'));
}

function hasPM2() {
  try {
    execSync('pm2 -v', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function startUsual() {
  console.clear();
  console.log(
    miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
    chalk.hex('#D5D5D5')('Starting bot (Start type: Usual)')
  );

  const bot = spawn('node', ['system/main.js'], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  bot.on('exit', (code) => {
	if (code === 0) {
		process.exit(0)
	}
    console.log(
      miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
      chalk.hex('#D5D5D5')(`Bot crashed (code: ${code}). Restarting...`)
    );
    setTimeout(startUsual, 3000);
  });

  bot.on('error', (err) => {
    console.log(
      miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
      chalk.hex('#D5D5D5')(`Error: ${err.message}`)
    );
  });
}

function startPM2() {
  console.clear();
  console.log(
    miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
    chalk.hex('#D5D5D5')(`Starting bot (Start type: PM2)`)
  );

  if (!hasPM2()) {
    console.log(
      miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
      chalk.hex('#D5D5D5')(`PM2 is not installed! Run: npm install -g pm2`)
    );
    process.exit(1);
  }

  try {
    execSync('pm2 start ecosystem.config.cjs', { stdio: 'inherit' });
    execSync('pm2 save', { stdio: 'inherit' });

    console.log(
      miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
      chalk.hex('#D5D5D5')(`Bot started with PM2`)
    );

    execSync('pm2 logs AuroraBot', { stdio: 'inherit' });

  } catch (err) {
    console.log(
      miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
      chalk.hex('#D5D5D5')(`PM2 start failed: ${err.message}`)
    );
  }
}

function menu() {
  console.clear();

  showHeader();

  console.log(chalk.yellow('1.'), 'Start bot (Start type: Usual)');
  console.log(chalk.yellow('2.'), 'Start bot (Start type: PM2)');
  console.log(chalk.yellow('3.'), 'Exit');

  separator();

  rl.question(chalk.hex('#D5D5D5')('Select option: '), (answer) => {
    switch (answer.trim()) {
      case '1':
        rl.close();
        startUsual();
        break;

      case '2':
        rl.close();
        startPM2();
        break;

      case '3':
        process.exit(0);

      default:
        console.log(
          miniMessage('<gradient:#7C00FF:#D0A3FF>[AuroraBot] </gradient>') +
          chalk.hex('#D5D5D5')(`Invalid option`)
        );
        setTimeout(menu, 1000);
    }
  });
}

menu();