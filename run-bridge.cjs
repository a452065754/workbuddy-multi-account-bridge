#!/usr/bin/env node
// 可移植启动器（供 start-bridge.bat 调用）
// 用法：双击 start-bridge.bat 或 node run-bridge.cjs
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const APP_DIR = __dirname;

function log(...a) {
  const line = `[${new Date().toISOString()}] ` + a.join(' ');
  console.log(line);
  try {
    const MIRROR_DIR = process.env.WORKBUDDY_MIRROR_DIR || path.join(os.homedir(), '.workbuddy-mirror');
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    fs.appendFileSync(path.join(MIRROR_DIR, 'webapp.log'), line + '\n');
  } catch {}
}

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~\//, os.homedir() + path.sep).replace(/^~\\/, os.homedir() + path.sep).replace(/^~$/, os.homedir());
}

function loadPortableConfig() {
  const file = path.join(APP_DIR, 'portable-config.txt');
  const cfg = {};
  if (!fs.existsSync(file)) return cfg;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) cfg[key] = expandHome(val);
  }
  return cfg;
}

function findWorkBuddy(envKey, cfg, candidates) {
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return { bin: process.env[envKey], source: 'env' };
  if (cfg[envKey] && fs.existsSync(cfg[envKey])) return { bin: cfg[envKey], source: 'portable-config' };
  for (const c of candidates) {
    const p = expandHome(c);
    if (fs.existsSync(p)) return { bin: p, source: 'auto' };
  }
  return { bin: '', source: 'missing' };
}

function ensurePlaywright() {
  const pkg = path.join(APP_DIR, 'node_modules', 'playwright', 'package.json');
  if (fs.existsSync(pkg)) return { ok: true, reason: 'playwright present' };
  log('[deps] playwright missing, running npm install ...');
  try {
    execSync('npm install --no-audit --no-fund', {
      cwd: APP_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32' ? 'cmd.exe' : false,
      timeout: 240000,
    });
  } catch (e) {
    log('[deps] npm install failed: ' + e.message);
    return { ok: false, reason: e.message.slice(0, 300) };
  }
  if (fs.existsSync(pkg)) return { ok: true, reason: 'playwright installed' };
  return { ok: false, reason: 'playwright still missing after npm install' };
}

function writePortableConfig(cfg, ai, cn) {
  const DSH_HOME = cfg.DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const MIRROR_DIR = cfg.WORKBUDDY_MIRROR_DIR || process.env.WORKBUDDY_MIRROR_DIR || path.join(os.homedir(), '.workbuddy-mirror');
  const PORT = cfg.WB_PORT || process.env.WB_PORT || '3085';
  const lines = [
    '# WorkBuddy multi-account bridge portable config',
    '# After copying this folder to another computer, edit the paths below if auto-detection is wrong.',
    '# "~" means the current user home directory.',
    '',
    'WORKBUDDY_AI_ELECTRON_BIN=' + (ai.bin || ''),
    '# WorkBuddyAI.exe international desktop client',
    'WORKBUDDY_ELECTRON_BIN=' + (cn.bin || ''),
    '# WorkBuddy.exe domestic desktop client',
    'DSH_HOME=' + DSH_HOME,
    'WORKBUDDY_MIRROR_DIR=' + MIRROR_DIR,
    'WORKBUDDY_PLUGIN_MAIN=' + (cfg.WORKBUDDY_PLUGIN_MAIN || path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'index.js')),
    'WB_PORT=' + PORT,
    '',
    '# Requirements on target machine:',
    '#   1. Node.js LTS installed',
    '#   2. For desktop account A: WorkBuddy / WorkBuddyAI desktop client installed',
    '#   3. For desktop account A: DSH web profile with dsh-workbuddy-connect installed',
    '#   4. Web accounts B/C/D... do not need requirements 2/3; carry login cookies via UI import/export.'
  ];
  try {
    fs.writeFileSync(path.join(APP_DIR, 'portable-config.txt'), lines.join('\n') + '\n', 'utf8');
    log('[config] portable-config.txt written with current detected paths');
  } catch (e) {
    log('[config] write portable-config.txt failed: ' + e.message);
  }
}

function mainSync() {
  log('=== WorkBuddy multi-account bridge portable launcher ===');
  log('app dir: ' + APP_DIR);

  const cfg = loadPortableConfig();
  log('[config] portable-config keys: ' + Object.keys(cfg).join(', '));

  const drives = ['C', 'D', 'E', 'F', 'G', 'H'].map(d => d + '\\');
  const aiCandidates = [
    ...drives.flatMap(d => [
      d + 'Program Files\\WorkBuddyAI\\WorkBuddyAI.exe',
      d + 'Program Files (x86)\\WorkBuddyAI\\WorkBuddyAI.exe',
      d + 'Software\\WorkBuddyAI\\WorkBuddyAI.exe',
    ]),
    'E:\\Program Files\\WorkBuddyAI\\WorkBuddyAI.exe',
  ];
  const cnCandidates = [
    ...drives.flatMap(d => [
      d + 'Program Files\\WorkBuddy\\WorkBuddy.exe',
      d + 'Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
      d + 'Software\\WorkBuddy\\WorkBuddy.exe',
    ]),
    'E:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
  ];

  const ai = findWorkBuddy('WORKBUDDY_AI_ELECTRON_BIN', cfg, aiCandidates);
  const cn = findWorkBuddy('WORKBUDDY_ELECTRON_BIN', cfg, cnCandidates);
  log('[workbuddy] AI desktop: ' + (ai.bin || 'MISSING') + ' source=' + ai.source);
  log('[workbuddy] CN desktop: ' + (cn.bin || 'MISSING') + ' source=' + cn.source);

  if (ai.bin) process.env.WORKBUDDY_AI_ELECTRON_BIN = ai.bin;
  if (cn.bin) process.env.WORKBUDDY_ELECTRON_BIN = cn.bin;
  if (cfg.DSH_HOME) process.env.DSH_HOME = cfg.DSH_HOME;
  if (cfg.WORKBUDDY_MIRROR_DIR) process.env.WORKBUDDY_MIRROR_DIR = cfg.WORKBUDDY_MIRROR_DIR;
  if (cfg.WORKBUDDY_PLUGIN_MAIN) process.env.WORKBUDDY_PLUGIN_MAIN = cfg.WORKBUDDY_PLUGIN_MAIN;
  if (cfg.WB_PORT) process.env.WB_PORT = cfg.WB_PORT;

  writePortableConfig(cfg, ai, cn);

  const pw = ensurePlaywright();
  log('[deps] ' + pw.reason);

  const port = process.env.WB_PORT || '3085';
  log('[run] launching wb-webapp.js (port ' + port + ')');

  const child = spawn(process.execPath, [path.join(APP_DIR, 'wb-webapp.js')], {
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('exit', (code, signal) => {
    log('[exit] wb-webapp.js exit code=' + code + ' signal=' + signal);
    process.exit(code || 0);
  });

  process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} });
  process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
}

mainSync();
