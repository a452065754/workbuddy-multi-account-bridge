#!/usr/bin/env node
// 生成 portable-config.txt（如果不存在或需要刷新）
// 记录本机自动检测到的路径，方便拷贝到其它机器后修改。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\\/g, '/'));

function exists(p) { try { return p && fs.existsSync(p); } catch { return false; } }

function findWorkBuddy(envKey, candidates, label) {
  const fromEnv = process.env[envKey];
  if (exists(fromEnv)) return { bin: fromEnv, source: 'env:' + envKey };
  for (const c of candidates) {
    const p = c.replace(/^~\//, os.homedir() + path.sep);
    if (exists(p)) return { bin: p, source: 'auto' };
  }
  return { bin: '', source: 'missing' };
}

function nodeVersion() {
  try { return execSync('node -v', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

const drives = ['C', 'D', 'E', 'F', 'G', 'H'].map(d => d + '\\');
const ai = findWorkBuddy('WORKBUDDY_AI_ELECTRON_BIN', [
  ...drives.flatMap(d => [
    d + 'Program Files\\WorkBuddyAI\\WorkBuddyAI.exe',
    d + 'Program Files (x86)\\WorkBuddyAI\\WorkBuddyAI.exe',
    d + 'Software\\WorkBuddyAI\\WorkBuddyAI.exe',
  ]),
  'E:\\Program Files\\WorkBuddyAI\\WorkBuddyAI.exe',
], 'WorkBuddyAI.exe');
const cn = findWorkBuddy('WORKBUDDY_ELECTRON_BIN', [
  ...drives.flatMap(d => [
    d + 'Program Files\\WorkBuddy\\WorkBuddy.exe',
    d + 'Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
    d + 'Software\\WorkBuddy\\WorkBuddy.exe',
  ]),
  'E:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
], 'WorkBuddy.exe');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const MIRROR_DIR = process.env.WORKBUDDY_MIRROR_DIR || path.join(os.homedir(), '.workbuddy-mirror');
const PORT = process.env.WB_PORT || '3085';

const lines = [
  '# WorkBuddy multi-account bridge portable config',
  '# 拷到其它电脑后，按实际安装路径修改下面各项；不需要 desktop 账号 A 可忽略 WorkBuddy/DSH。',
  '# 路径里 ~ 表示当前用户主目录。修改后保存，再双击 start-bridge.bat。',
  '',
  'WORKBUDDY_AI_ELECTRON_BIN=' + (ai.bin || ''),
  '# WorkBuddyAI.exe (国际版桌面客户端) source=' + ai.source,
  'WORKBUDDY_ELECTRON_BIN=' + (cn.bin || ''),
  '# WorkBuddy.exe (国内版桌面客户端) source=' + cn.source,
  'DSH_HOME=' + DSH_HOME,
  'WORKBUDDY_MIRROR_DIR=' + MIRROR_DIR,
  'WB_PORT=' + PORT,
  '',
  '# 目标机器需要满足：',
  '#   1. 安装 Node.js LTS（' + nodeVersion() + ' 或更新）',
  '#   2. 若要用账号 A（桌面），安装 WorkBuddy / WorkBuddyAI 桌面客户端',
  '#   3. 若要用账号 A（桌面），安装 DSH web profile 并装 dsh-workbuddy-connect 插件',
  '#   4. 网页账号 B/C/D... 不需要上述 2/3，登录 cookie 通过「认证信息导入/导出」搬运',
];
fs.writeFileSync(path.join(__dirname, 'portable-config.txt'), lines.join('\n') + '\n', 'utf8');
console.log('written portable-config.txt:');
console.log(lines.join('\n'));
