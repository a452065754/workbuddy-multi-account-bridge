#!/usr/bin/env node
// 从 portable-config.txt 读取 KEY=VALUE，输出 KEY="VALUE" 形式的批处理 set 语句（带延迟展开安全值）。
// 用法：
//   for /f "usebackq delims=" %%L in (`node "%~dp0load-portable-config.cjs"`) do set "%%L"
// 这样 bat 里不用自己解析 KEY=VALUE，避免引号/中文/斜杠导致的解析坑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = path.join(__dirname, 'portable-config.txt');
const lines = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/) : [];

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const out = [];
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  // 去掉成对引号
  if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
  if (!KEY_RE.test(key)) continue;
  // 值里可能含空格/引号；把内层引号转义为 \，再用 " 包裹整体，bat set 能正确接受
  const escaped = val.replace(/"/g, '\\"');
  out.push(`${key}="${escaped}"`);
}
// 用 process.stdout 逐行输出；CRLF 让 bat 的 for /f 稳定读取
process.stdout.write(out.join('\r\n') + (out.length ? '\r\n' : ''));
