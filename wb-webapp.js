#!/usr/bin/env node
// WorkBuddy multi-account bridge - single-file web app
// Run via start-bridge.bat or `node wb-webapp.js`:
//   1. Serves web UI at 127.0.0.1:3085 (auto-opens browser)
//   2. Account A = desktop client sign-in (official 0.7.2 plugin decrypts it)
//   3. Accounts B/C/D/... = web cookie logins (.ai international / .cn domestic)
//   4. Auto-route: pick the account with the most credits; switch on depletion
//   5. OpenAI-compatible loopback proxy for WorkBuddy models
//   6. Re-route every 30 min; daily 09:00 login-bonus window
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function expandHome(p) {
  if (!p) return p;
  return String(p)
    .replace(/^~\//, os.homedir() + path.sep)
    .replace(/^~\\/, os.homedir() + path.sep)
    .replace(/^~$/, os.homedir());
}

function firstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return paths[0] || '';
}

function findWorkBuddyElectron(envKey, candidates, label) {
  const fromEnv = process.env[envKey] || PCONFIG[envKey];
  if (fromEnv && fs.existsSync(fromEnv)) return { bin: fromEnv, source: 'env/' + envKey, label };
  const found = firstExisting(candidates.map(c => c.replace(/^~\//, os.homedir() + path.sep).replace(/^~\\/, os.homedir() + path.sep)));
  if (found && fs.existsSync(found)) return { bin: found, source: 'auto', label };
  return { bin: candidates[0] || '', source: 'missing', label };
}

function loadPortableConfig() {
  const file = path.join(__dirname, 'portable-config.txt');
  const cfg = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) cfg[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {}
  return cfg;
}
const PCONFIG = loadPortableConfig();

function applyConfigPath(target) {
  const env = process.env[target] || PCONFIG[target];
  if (env) process.env[target] = expandHome(env);
  return process.env[target] || '';
}

const DSH_HOME = applyConfigPath('DSH_HOME') || path.join(os.homedir(), '.dsh');
process.env.DSH_HOME = DSH_HOME;
const MIRROR_DIR = applyConfigPath('WORKBUDDY_MIRROR_DIR') || path.join(os.homedir(), '.workbuddy-mirror');
process.env.WORKBUDDY_MIRROR_DIR = MIRROR_DIR;
// 允许 portable-config.txt 里直接给 DSH plugin 的绝对路径，避免依赖 DSH_HOME 结构
const PLUGIN_MAIN = applyConfigPath('WORKBUDDY_PLUGIN_MAIN') || path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-workbuddy-connect', 'lib', 'index.js');
const META_FILE = path.join(MIRROR_DIR, 'meta.json');
const ROUTE_FILE = path.join(MIRROR_DIR, 'active-account.json');
const LOG_FILE = path.join(MIRROR_DIR, 'webapp.log');
const EP_FILE = path.join(MIRROR_DIR, 'loopback-endpoint.json');

const driveLetters = process.platform === 'win32'
  ? ['C', 'D', 'E', 'F', 'G', 'H'].map(d => `${d}\\`)
  : [];
const workbuddyBaseCandidates = [
  'C:\\Program Files', 'C:\\Program Files (x86)',
  ...driveLetters.map(d => `${d}\\Program Files`),
  ...driveLetters.map(d => `${d}\\Program Files (x86)`),
  ...driveLetters.map(d => `${d}\\Software`),
];

const AI_ELECTRON = findWorkBuddyElectron('WORKBUDDY_AI_ELECTRON_BIN', [
  ...workbuddyBaseCandidates.map(d => path.join(d, 'WorkBuddyAI', 'WorkBuddyAI.exe')),
  'E:\\Program Files\\WorkBuddyAI\\WorkBuddyAI.exe',
], 'WorkBuddyAI.exe (international desktop)');
const CN_ELECTRON = findWorkBuddyElectron('WORKBUDDY_ELECTRON_BIN', [
  ...workbuddyBaseCandidates.map(d => path.join(d, 'WorkBuddy', 'WorkBuddy.exe')),
  'E:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
], 'WorkBuddy.exe (domestic desktop)');

process.env.WORKBUDDY_AI_ELECTRON_BIN = AI_ELECTRON.bin || 'E:\\Program Files\\WorkBuddyAI\\WorkBuddyAI.exe';
process.env.WORKBUDDY_ELECTRON_BIN = CN_ELECTRON.bin || 'E:\\Program Files\\WorkBuddy\\WorkBuddy.exe';

const PORT = parseInt(applyConfigPath('WB_PORT') || process.env.WB_PORT || '3085', 10);
const HOST = '127.0.0.1';

// API Key 持久化：存到 MIRROR_DIR/api-token.txt，重启后不变；
// 仅当文件不存在时才生成新 Key。删除 = 清空文件（清空后 /v1/* 拒绝请求，需重新生成）。
function readStoredToken() {
  try {
    const t = fs.readFileSync(path.join(MIRROR_DIR, 'api-token.txt'), 'utf8').trim();
    return t || '';
  } catch { return ''; }
}
function writeStoredToken(t) {
  try {
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    fs.writeFileSync(path.join(MIRROR_DIR, 'api-token.txt'), t || '', 'utf8');
  } catch (e) { log('[token] write fail:', e.message); }
}
// 启动：有持久化 key 就复用，没有才生成
let TOKEN = readStoredToken();
if (!TOKEN) { TOKEN = crypto.randomBytes(24).toString('hex'); writeStoredToken(TOKEN); log('[token] generated new API key (not stored)'); }
else log('[token] reused persisted API key');

function log(...a) {
  const line = `[${new Date().toISOString()}] ` + a.join(' ');
  console.log(line);
  try { fs.mkdirSync(MIRROR_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8') || '{}'); } catch { return {}; }
}
function writeMeta(meta) {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}
function loadPlugin() {
  return import('file:///' + PLUGIN_MAIN.replace(/\\/g, '/'));
}

// ============ Account A: desktop client sign-in (official 0.7.2 decrypt) ============
async function accountA() {
  process.env.WORKBUDDY_AI_ELECTRON_BIN = AI_ELECTRON.bin;
  process.env.WORKBUDDY_ELECTRON_BIN = CN_ELECTRON.bin;
  try {
    const plugin = await loadPlugin();
    const store = new plugin.WorkBuddyCredentialStore({ variant: plugin.AI_VARIANT });
    let status;
    try { status = await store.status(); } catch (e) { return { ok: false, reason: e.message.slice(0, 200), source: 'desktop' }; }
    if (status.state !== 'signed-in') return { ok: false, reason: status.reason || 'signed-out', source: 'desktop' };
    const client = new plugin.WorkBuddyUpstreamClient({ variant: plugin.AI_VARIANT });
    let credits = { total: 0 };
    let uid = '';
    let freeModels = [];
    try {
      const cred = await store.current();
      uid = cred.uid || '';
      const b = await client.fetchCredits(cred);
      credits = { total: b.total, accounts: b.accounts?.length || 0 };
      const ms = await client.fetchModels(cred);
      freeModels = ms.filter(m => m.billing?.free === true).map(m => m.id);
    } catch (e) {
      credits = { total: 0, error: e.message.slice(0, 120) };
    }
    return { ok: true, uid, credits, freeModels, source: 'desktop' };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 200), source: 'desktop' };
  }
}

// ============ Any account key (B/C/D/...): web cookie login ============
async function accountWeb(key) {
  const meta = readMeta();
  const acc = meta[key];
  if (!acc?.cookieFile || !fs.existsSync(acc.cookieFile)) return { key, ok: false, reason: 'not-logged-in', source: 'web-cookie' };
  const region = acc.region === 'cn' ? 'cn' : 'ai';
  const domain = region === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai';
  const cookies = JSON.parse(fs.readFileSync(acc.cookieFile, 'utf8'));
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = {
    Cookie: cookieStr, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'
  };
  let credits = { total: 0 };
  try {
    const r = await fetch(`https://${domain}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: `https://${domain}`, Referer: `https://${domain}/` },
      body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }),
      signal: AbortSignal.timeout(20000)
    });
    if (r.status === 200) {
      const j = await r.json().catch(() => null);
      const inner = j?.data?.Response?.Data?.Accounts || j?.data?.Accounts || [];
      let total = 0;
      for (const a of inner) total += (a.CycleCapacityRemain || a.CapacityRemain || 0);
      credits = { total, accounts: inner.length };
    } else {
      credits = { total: 0, status: r.status };
    }
  } catch (e) {
    credits = { total: 0, error: e.message.slice(0, 100) };
  }
  return { key, ok: true, region, uid: acc.uid || '', loggedInAt: acc.loggedInAt, credits, source: 'web-cookie' };
}

function webAccountKeys() {
  const meta = readMeta();
  return Object.keys(meta).filter(k => /^[A-Z]$/.test(k) && k !== 'A').sort();
}

// ============ Route: pick the account with the most credits ============
async function route() {
  log('=== route poll ===');
  const A = await accountA();
  A.key = 'A';
  A.name = keyName('A');
  const webs = await Promise.all(webAccountKeys().map(k => accountWeb(k)));
  webs.forEach(w => { w.name = keyName(w.key); });
  const all = [A, ...webs];
  const ranked = all.filter(x => x.ok).map((x, i) => ({ ...x, _idx: i })).sort((x, y) => {
    const cx = x.credits?.total || 0, cy = y.credits?.total || 0;
    if (cy !== cx) return cy - cx;
    return x._idx - y._idx;
  });
  let active = null, reason = '';
  if (ranked.length) {
    active = ranked[0];
    reason = (active.credits?.total > 0)
      ? `${active.name} 积分 ${active.credits.total}，主用`
      : '都没有积分，留在线账号兜底（上游会报错）';
  } else reason = '没有可用账号';

  const decision = {
    activeKey: active?.key || null,
    activeName: active?.name || null,
    at: new Date().toISOString(),
    accounts: all,
    reason,
    loopback: { baseUrl: `http://${HOST}:${PORT}/v1`, token: TOKEN, upstream: upstreamDomainOf(active) }
  };
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  fs.writeFileSync(ROUTE_FILE, JSON.stringify(decision, null, 2));
  log('route ->', active?.key || '(none)', '|', reason);
  return decision;
}

// 当前活跃账号实际上游调用域名（供 UI 展示「调用地址」）
function upstreamDomainOf(active) {
  if (!active) return '';
  if (active.key === 'A') return 'www.workbuddy.ai (desktop plugin)';
  const domain = active.region === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai';
  return domain + ' (cookie)';
}

// ============ Web account login (Playwright Chrome, key B/C/D/..., region ai/cn) ============
const loginBusy = new Set();

// 探测系统里已登录 Google 的真实 Chrome 用户配置目录。
// 用它启动可让 Google OAuth 风控识别为「你日常用的浏览器」，避免「此浏览器可能不安全」拦截；
// 同时复用它已登录的 Google 会话，免去二次扫码/输密码。
function findChromeUserDataDir() {
  if (process.platform === 'win32') {
    const cands = [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
      path.join(process.env.APPDATA || '', 'Google', 'Chrome', 'User Data'),
    ];
    for (const c of cands) if (c && fs.existsSync(path.join(c, 'Local State'))) return c;
  }
  return '';
}
function findChromeExecutable() {
  if (process.platform === 'win32') {
    const cands = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of cands) if (c && fs.existsSync(c)) return c;
  }
  return '';
}

async function loginWeb(key, region = 'ai') {
  if (loginBusy.has(key)) return { ok: false, key, reason: 'login already in progress, wait' };
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { return { ok: false, key, reason: 'playwright not installed; run npm install playwright' }; }
  loginBusy.add(key);
  const domain = region === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai';
  const cookieFile = path.join(MIRROR_DIR, `account-${key}.${region}.cookies.json`);
  let ctx;
  let ownedBrowser = null;
  try {
    // 无痕模式（incognito）：干净会话，不带你日常 Chrome 的登录态/指纹
    log(`[login] ${key} @ ${domain} opening incognito Chrome`);
    ownedBrowser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      args: [
        '--no-first-run', '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    ctx = await ownedBrowser.newContext({
      locale: region === 'cn' ? 'zh-CN' : 'en-US',
      viewport: { width: 1100, height: 850 },
    });
    // 清掉自动化指纹，降低 Google 风控识别概率
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'en-US'] });
      window.chrome = { runtime: {} };
    });
    const page = await ctx.newPage();
    await page.goto(`https://${domain}/console/account`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    log(`[login] opened ${key} @ ${domain}, waiting for user`);
    let loggedIn = false;
    const deadline = Date.now() + 600 * 1000;
    while (Date.now() < deadline) {
      try { await page.waitForTimeout(2000); } catch { break; }
      try {
        // 检查所有打开的页面（含 Google OAuth 弹窗/新标签）里是否出现登录态标志
        const pages = ctx.pages();
        for (const p of pages) {
          let t = '';
          try { t = await p.evaluate(() => document.body ? document.body.innerText : ''); } catch { continue; }
          if (/Sign out|退出|积分|余额|套餐|我的|订阅|账号设置|Credits|Plan|Billing|workbuddy\.ai\/console/.test(t)) { loggedIn = true; break; }
        }
        if (loggedIn) break;
      } catch { /* 页面跳转/弹窗造成的 evaluate 失败，不中断等待 */ }
    }
    let cookies = [];
    try { cookies = await ctx.cookies(`https://${domain}`); } catch {}
    // 有真实登录 cookie 也算成功（即使文本没匹配到）
    if (!loggedIn && cookies.length >= 3) loggedIn = true;
    const meta = readMeta();
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    if (cookies.length) fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    meta[key] = { loggedIn, region, loggedInAt: new Date().toISOString(), cookieFile, cookieCount: cookies.length };
    writeMeta(meta);
    log(`[login] done key=${key} region=${region} loggedIn=${loggedIn} cookies=${cookies.length}`);
    await route().catch(() => {});
    return { ok: true, key, loggedIn, cookies: cookies.length, region, cookieFile };
  } catch (e) {
    log('[login] error:', e.message);
    return { ok: false, key, reason: e.message.slice(0, 200) };
  } finally {
    try { await ctx?.close(); } catch {}
    try { await ownedBrowser?.close(); } catch {}
    loginBusy.delete(key);
  }
}

function keyName(key) {
  if (key === 'A') return '账号 A（桌面客户端）';
  return `账号 ${key}（网页登录）`;
}

// ============ 认证信息导出 / 导入（cookie 打包，可在外网/内网间搬运） ============
// 网页账号 B/C/D... 的登录态就是一组 cookie。导出成 bundle 后可在另一台电脑（或重装系统后）
// 粘贴导入，免去重新扫码登录。桌面账号 A 是本地加密凭据，无法搬运，重装后需重新用桌面客户端登录。
function readCookiesOf(key) {
  const meta = readMeta();
  const acc = meta[key];
  if (!acc?.cookieFile || !fs.existsSync(acc.cookieFile)) return null;
  try { return JSON.parse(fs.readFileSync(acc.cookieFile, 'utf8')); } catch { return null; }
}

// 导出：给定 keys（或 'all' 全部网页账号），返回 bundle 对象
function exportBundle(keys) {
  const meta = readMeta();
  const selected = keys && keys.length ? keys : webAccountKeys();
  const accounts = {};
  for (const k of selected) {
    const acc = meta[k];
    if (!acc) continue;
    const cookies = readCookiesOf(k) || [];
    accounts[k] = {
      region: acc.region === 'cn' ? 'cn' : 'ai',
      uid: acc.uid || '',
      loggedInAt: acc.loggedInAt || null,
      cookieCount: cookies.length,
      cookies
    };
  }
  return {
    type: 'workbuddy-multi-account-auth',
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts
  };
}

// 导入：接受 bundle 对象（或 base64 / JSON 字符串）。写入 cookie 文件 + meta，返回导入结果
function importBundle(input) {
  let bundle = input;
  if (typeof bundle === 'string') {
    const s = bundle.trim();
    let parsed = null;
    try { parsed = JSON.parse(s); } catch { parsed = null; }
    if (!parsed) {
      try {
        const bin = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
        parsed = JSON.parse(bin);
      } catch { parsed = null; }
    }
    if (!parsed) return { ok: false, reason: '无法解析认证信息（既不是 JSON 也不是 base64）' };
    bundle = parsed;
  }
  if (!bundle || typeof bundle !== 'object' || !bundle.accounts) return { ok: false, reason: '认证信息格式不正确' };
  const meta = readMeta();
  const imported = [];
  const skipped = [];
  for (const [k, acc] of Object.entries(bundle.accounts)) {
    if (!/^[A-Z]$/.test(k) || k === 'A') { skipped.push(k); continue; }
    const region = acc.region === 'cn' ? 'cn' : 'ai';
    const cookies = Array.isArray(acc.cookies) ? acc.cookies : [];
    const cookieFile = path.join(MIRROR_DIR, `account-${k}.${region}.cookies.json`);
    fs.mkdirSync(MIRROR_DIR, { recursive: true });
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    meta[k] = {
      region,
      loggedIn: cookies.length > 0,
      uid: acc.uid || '',
      loggedInAt: acc.loggedInAt || new Date().toISOString(),
      cookieFile,
      cookieCount: cookies.length,
      importedAt: new Date().toISOString()
    };
    imported.push({ key: k, region, cookies: cookies.length });
  }
  writeMeta(meta);
  log(`[import] imported=${imported.map(x => x.key).join(',')} skipped=${skipped.join(',')}`);
  return { ok: true, imported, skipped };
}

// ============ HTML UI (dynamic multi-account, i18n: zh default / en optional) ============
function uiPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 多账号桥接</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--mut:#8b949e;--acc:#2f81f7;--ok:#3fb950;--warn:#d29922}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;background:var(--bg);color:var(--fg)}
.wrap{max-width:820px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--mut);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:16px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--mut);display:inline-block}
.dot.on{background:var(--ok)}.dot.off{background:#f85149}
.row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--bd);font-size:13px}
.row:last-child{border-bottom:0}
.k{color:var(--mut)}.v{font-family:ui-monospace,Consolas,monospace}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;margin-top:10px}
.btn:hover{filter:brightness(1.1)}.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.warn{background:var(--warn);color:#000}.btn.ghost{background:transparent;border:1px solid var(--bd);color:var(--fg)}
.btn.sm{padding:5px 10px;font-size:12px;margin-top:8px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:#0a0d12;border:1px solid var(--bd);border-radius:6px;padding:10px;white-space:pre-wrap;word-break:break-all;color:var(--mut)}
.tag{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--bd)}
.tag.route{color:var(--acc);border-color:var(--acc)}
.note{color:var(--mut);font-size:12px;margin-top:8px}
.acc-card{border-left:3px solid var(--bd)}
.acc-card.active{border-left:3px solid var(--ok);background:linear-gradient(90deg,rgba(63,185,80,.08),var(--card))}
.acc-card h3{font-size:14px;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--bd);color:var(--mut)}
.chip.free{color:var(--ok);border-color:var(--ok)}
.chip.region{color:var(--acc);border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
footer{color:var(--mut);font-size:11px;text-align:center;padding:18px 0 30px}
.pulse{animation:pulse 1.4s infinite}.pulse.on{color:var(--ok)}
@keyframes pulse{50%{opacity:.4}}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.lang{display:inline-flex;gap:6px}
.lang button{background:transparent;border:1px solid var(--bd);color:var(--mut);border-radius:5px;padding:2px 8px;font-size:11px;cursor:pointer}
.lang button.on{color:#fff;border-color:var(--acc);background:var(--acc)}
.copy-btn{margin-top:0;padding:3px 8px;font-size:11px;flex-shrink:0}
.copy-btn.copied{color:var(--ok);border-color:var(--ok);background:transparent}
</style></head>
<body><div class="wrap">
<div class="topbar">
  <h1 data-i18n="title">WorkBuddy 多账号桥接</h1>
  <div class="lang"><button id="langZh">中文</button><button id="langEn">EN</button></div>
</div>
<div class="sub" data-i18n="sub">账号 A（桌面客户端）+ 网页账号 B/C/D/... · 额度耗尽自动切换 · 每天 09:00 刷登录积分 · 内置 OpenAI 兼容端点</div>

<div class="card">
  <h2><span class="dot" id="loopDot"></span> <span data-i18n="proxy">接口地址（OpenAI 兼容）</span> <span class="tag route" id="routeTag">...</span></h2>
  <div class="row"><span class="k" data-i18n="baseUrl">调用地址</span><span style="display:flex;align-items:center;gap:6px"><span class="v" id="baseUrl"></span><button class="btn ghost sm copy-btn" id="copyBaseUrl">复制</button></span></div>
  <div class="row"><span class="k" data-i18n="apiKey">API Key</span><span style="display:flex;align-items:center;gap:6px"><span class="v" id="apiToken"></span><button class="btn ghost sm copy-btn" id="copyApiToken">复制</button><button class="btn ghost sm copy-btn" id="genToken" data-i18n="genKey">生成</button><button class="btn warn sm copy-btn" id="delToken" data-i18n="delKey">删除</button></span></div>
  <div class="row"><span class="k" data-i18n="upstream">上游调用</span><span class="v" id="upstream">...</span></div>
  <div class="row"><span class="k" data-i18n="active">活跃账号</span><span class="v"><span class="pulse" id="activeName">...</span></span></div>
  <button class="btn ghost sm" id="btnRoute" data-i18n="reroute">立即重新路由</button>
  <div class="note" data-i18n="proxyNote">把 Base URL + API Key 填进任何 OpenAI 兼容客户端。免费模型：deepseek-v4.1-flash、hy3、step-5-preview</div>
</div>

<div class="card">
  <h2><span class="dot" id="loopDot2"></span> <span data-i18n="accList">账号列表</span> <span class="note" style="font-size:12px" data-i18n="addHint">（点「+ 新增账号」可继续加 B/C/D/...）</span></h2>
  <div class="grid" id="accountsWrap"></div>
  <button class="btn sm" id="btnAdd" data-i18n="add">＋ 新增账号</button>
  <div id="addRegionPick" style="display:none;margin-top:10px;padding:10px;border:1px solid var(--bd);border-radius:6px;background:#0a0d12">
    <div class="note" id="addRegionTitle" style="margin-bottom:8px"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn sm" id="btnAddInt" data-i18n="addInt">国际版 .ai</button>
      <button class="btn warn sm" id="btnAddCn" data-i18n="addCn">国内版 .cn</button>
      <button class="btn ghost sm" id="btnAddCancel" data-i18n="cancel">取消</button>
    </div>
  </div>
  <div class="note" data-i18n="accNote">每个账号都支持国际版 workbuddy.ai 和国内版 workbuddy.cn，点登录弹 Chrome 扫码</div>
</div>

<div class="card">
  <h2><span data-i18n="authTitle">认证信息 导入 / 导出</span></h2>
  <div class="note" data-i18n="authHint">外网电脑登录后可「导出」认证信息，在内网/重装后「导入」即可，不用再扫码</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
    <button class="btn sm" id="btnExportAll" data-i18n="authExportAll">导出全部网页账号</button>
    <button class="btn ghost sm" id="btnDownload" data-i18n="authDownload">下载为文件</button>
  </div>
  <div style="margin-top:12px">
    <div class="note" data-i18n="authPasteLabel">粘贴认证信息（导出复制的内容，或文件内容）：</div>
    <textarea id="importArea" rows="4" style="width:100%;margin-top:6px;background:#0a0d12;color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;resize:vertical"></textarea>
    <button class="btn warn sm" id="btnImport" data-i18n="authImport">导入</button>
  </div>
  <div class="note" data-i18n="authNote">桌面账号 A 是本地加密凭据无法搬运，重装后需用桌面客户端重新登录；网页账号 B/C/D... 的 cookie 可导出导入</div>
</div>

<div class="card">
  <h2 data-i18n="lastRoute">最近路由</h2>
  <div class="mono" id="lastRoute">...</div>
</div>

<footer data-i18n="footer">WorkBuddy 多账号桥接 v0.3 · 本地 127.0.0.1:3085 · 仅本机可用</footer>
</div>
<script>
const $=id=>document.getElementById(id);
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function setDot(id,on){const d=$(id);if(d)d.className='dot '+(on?'on':'off')}
async function j(url,opt){const r=await fetch(url,opt||{});return r.json()}
function nextKey(used){for(const l of 'BCDEFGHIJKLMNOPQRSTUVWXYZ'){if(!used.includes(l))return l}return null}

// ===== i18n: zh default, en optional =====
const I18N={
  zh:{
    title:'WorkBuddy 多账号桥接',
    sub:'账号 A（桌面客户端）+ 网页账号 B/C/D/... · 额度耗尽自动切换 · 每天 09:00 刷登录积分 · 内置 OpenAI 兼容端点',
    proxy:'接口地址（OpenAI 兼容）', baseUrl:'调用地址', apiKey:'API Key', upstream:'上游调用', active:'活跃账号',
    genKey:'生成', delKey:'删除', keyGen:'已生成新 API Key（请重新复制到客户端）', keyDel:'API Key 已删除，客户端需重新生成后才能调用', keyEmpty:'未设置',
    reroute:'立即重新路由',
    proxyNote:'把 Base URL + API Key 填进任何 OpenAI 兼容客户端。免费模型：deepseek-v4.1-flash、hy3、step-5-preview',
    accList:'账号列表', addHint:'（点「+ 新增账号」可继续加 B/C/D/...）',
    add:'＋ 新增账号', addInt:'登录 国际版 .ai', addCn:'登录 国内版 .cn', cancel:'取消',
    activeReasonMain:'积分 {n}，主用', activeReasonNone:'都没有积分，留在线账号兜底（上游会报错）', activeReasonEmpty:'没有可用账号',
    addPick:'新账号 {k} 选择地区：',
    accNote:'每个账号都支持国际版 workbuddy.ai 和国内版 workbuddy.cn，点登录弹 Chrome 扫码',
    lastRoute:'最近路由',
    footer:'WorkBuddy 多账号桥接 v0.3 · 本地 127.0.0.1:3085 · 仅本机可用',
    accDesktop:'账号 A（桌面客户端）',
    accWeb:'账号 {k}（网页登录）',
    activeTag:'★ 当前活跃', status:'状态', credits:'积分', loggedIn:'登录时间',
    online:'在线', offline:'离线', activeNow:'活跃中',
    reloginInt:'重新登录 国际版', reloginCn:'重新登录 国内版',
    regionInt:'国际版 .ai', regionCn:'国内版 .cn',
    freeLabel:'免费',
    acctHasCredits:'账号 A（桌面客户端） 积分 {n}，主用',
    noCredits:'都无积分，留在线账号兜底（上游会报错）',
    noAccount:'没有可用账号',
    loginOpening:'即将弹出 Chrome 登录 账号 {k}（{r}），请完成扫码。',
    loginOk:'账号 {k} 登录成功，cookie 已保存',
    loginNoFinish:'登录未完成，请重试',
    loginFail:'失败：{msg}',
    addPrompt:'新账号 {k} 选地区：\\nai=国际版 workbuddy.ai（默认）\\ncn=国内版 workbuddy.cn',
    addNoMore:'没有更多可用的账号字母了',
    addOpen:'即将弹出 Chrome 登录 账号 {k}（{r}），请扫码完成。',
    authTitle:'认证信息 导入 / 导出',
    authHint:'外网电脑登录后可「导出」认证信息，在内网/重装后「导入」即可，不用再扫码',
    authExportAll:'导出全部网页账号',
    authDownload:'下载为文件',
    authCopyOne:'复制认证',
    authPasteLabel:'粘贴认证信息（导出复制的内容，或文件内容）：',
    authImport:'导入',
    authExportedN:'已复制 {n} 个账号的认证信息到剪贴板',
    authImportedOk:'导入成功 {list}，已重新路由',
    authImportFail:'导入失败：{msg}',
    authNoWeb:'没有可导出的网页账号',
    authNote:'桌面账号 A 是本地加密凭据无法搬运，重装后需用桌面客户端重新登录；网页账号 B/C/D... 的 cookie 可导出导入'
  },
  en:{
    title:'WorkBuddy Multi-Account Bridge',
    sub:'Account A (desktop client) + web accounts B/C/D/... - auto-switch on credit depletion - daily 09:00 login-bonus - built-in OpenAI-compatible endpoint',
    proxy:'Endpoint (OpenAI-compatible)', baseUrl:'Endpoint URL', apiKey:'API Key', upstream:'Upstream', active:'Active Account',
    genKey:'Generate', delKey:'Delete', keyGen:'New API Key generated (re-copy to your client)', keyDel:'API Key deleted, client must regenerate before use', keyEmpty:'not set',
    reroute:'Re-route now',
    proxyNote:'Fill Base URL + API Key into any OpenAI-compatible client. Free models: deepseek-v4.1-flash, hy3, step-5-preview',
    accList:'Account List', addHint:'(click "+ Add Account" to add B/C/D/...)',
    add:'+ Add Account', addInt:'Login international .ai', addCn:'Login domestic .cn', cancel:'Cancel',
    activeReasonMain:'{n} credits, primary', activeReasonNone:'no credits anywhere, keeping an online account as fallback', activeReasonEmpty:'no usable account',
    addPick:'New account {k} choose region:',
    accNote:'Each account supports international (workbuddy.ai) and domestic (workbuddy.cn). Click login to open Chrome scan.',
    lastRoute:'Last Route',
    footer:'WorkBuddy Multi-Account Bridge v0.3 - local 127.0.0.1:3085 - loopback only',
    accDesktop:'Account A (desktop client)',
    accWeb:'Account {k} (web login)',
    activeTag:'active', status:'Status', credits:'Credits', loggedIn:'Logged in',
    online:'online', offline:'offline', activeNow:'ACTIVE',
    reloginInt:'Re-login international', reloginCn:'Re-login domestic',
    regionInt:'international .ai', regionCn:'domestic .cn',
    freeLabel:'FREE',
    acctHasCredits:'{name} has {n} credits, primary',
    noCredits:'no credits anywhere, keeping an online account as fallback',
    noAccount:'no usable account',
    loginOpening:'Chrome will open for account {k} ({r}). Complete the scan.',
    loginOk:'Account {k} login success',
    loginNoFinish:'login not finished, retry',
    loginFail:'failed: {msg}',
    addPrompt:'New account {k} region (ai=international .cn=domestic):',
    addNoMore:'no more letters',
    addOpen:'Chrome will open for {k} ({r}). Complete the scan.',
    authTitle:'Auth Info Import / Export',
    authHint:'On an online machine, "Export" after login; on intranet/after reinstall, "Import" - no re-scan needed',
    authExportAll:'Export all web accounts',
    authDownload:'Download as file',
    authCopyOne:'Copy auth',
    authPasteLabel:'Paste auth info (exported text, or file content):',
    authImport:'Import',
    authExportedN:'Copied auth for {n} accounts to clipboard',
    authImportedOk:'Imported {list}, re-routed',
    authImportFail:'Import failed: {msg}',
    authNoWeb:'No web accounts to export',
    authNote:'Desktop account A is a local encrypted credential, not portable; re-sign in via desktop client after reinstall. Web accounts B/C/D... cookies can be exported/imported.'
  }
};
let LANG=localStorage.getItem('wb-lang')||'zh';
function t(key,vars){
  let s=(I18N[LANG]||I18N.zh)[key]||I18N.zh[key]||key;
  if(vars)for(const[k,v]of Object.entries(vars))s=s.replace('{'+k+'}',v);
  return s;
}
function applyI18n(){
  document.documentElement.lang=LANG==='zh'?'zh-CN':'en';
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n)});
  const zhBtn=$('langZh'),enBtn=$('langEn');
  if(zhBtn)zhBtn.className=LANG==='zh'?'on':'';
  if(enBtn)enBtn.className=LANG==='en'?'on':'';
  refresh();
}
function setLang(l){LANG=l;localStorage.setItem('wb-lang',l);applyI18n()}
$('langZh').onclick=()=>setLang('zh');
$('langEn').onclick=()=>setLang('en');

function keyName(key){return key==='A'?t('accDesktop'):t('accWeb',{k:key})}
function regionLabel(r){return r==='cn'?t('regionCn'):t('regionInt')}
function accCard(a,activeKey){
  const isDesktop=a.source==='desktop';
  const ok=a.ok?'on':'off';
  const active=a.key===activeKey;
  const freeModels=(a.freeModels||[]).map(m=>'<span class="chip free">'+t('freeLabel')+' '+esc(m)+'</span>').join('');
  const regionTag=a.region?'<span class="chip region">'+esc(regionLabel(a.region))+'</span>':'';
  const cred=a.credits?.total??'-';
  const statusText=a.ok?(active?t('activeNow'):(t('online')+' · '+cred+' '+t('credits'))):(a.reason||t('offline'));
  let html='<div class="acc-card '+(active?'active':'')+'">'
    +'<h3><span class="dot '+ok+'"></span> '+esc(keyName(a.key))+' '+(active?'<span class="tag route">'+esc(t('activeTag'))+'</span>':'')+' '+regionTag+'</h3>'
    +'<div class="row"><span class="k">'+t('status')+'</span><span class="v">'+esc(statusText)+'</span></div>'
    +'<div class="row"><span class="k">'+t('credits')+'</span><span class="v">'+cred+'</span></div>';
  if(!isDesktop) html+='<div class="row"><span class="k">'+t('loggedIn')+'</span><span class="v">'+esc(a.loggedInAt?new Date(a.loggedInAt).toLocaleString(LANG==='zh'?'zh-CN':'en-US'):'-')+'</span></div>';
  if(freeModels) html+='<div class="chips">'+freeModels+'</div>';
  if(!isDesktop){
    const rl=a.region==='cn'?t('reloginCn'):t('reloginInt');
    html+='<button class="btn sm" onclick="doLogin(\\''+a.key+'\\','+'\\''+(a.region||'ai')+'\\')">'+esc(rl)+'</button>'
      +'<button class="btn ghost sm" onclick="copyAuthOne(\\''+a.key+'\\')">'+esc(t('authCopyOne'))+'</button>';
  }
  html+='</div>';
  return html;
}
function reasonText(active){
  // 按当前语言渲染活跃原因
  if(!active) return t('activeReasonEmpty');
  const n=active.credits?.total||0;
  if(n>0) return t('activeReasonMain',{n:n});
  return t('activeReasonNone');
}
async function refresh(){
  try{
    const s=await j('/api/accounts');
    $('baseUrl').textContent=s.loopback.baseUrl;
    $('apiToken').textContent=s.loopback.token||'-';
    $('upstream').textContent=s.loopback.upstream||'-';
    $('routeTag').textContent=s.activeKey||'-';
    const activeAcc=(s.accounts||[]).find(a=>a.key===s.activeKey);
    $('activeName').textContent=((s.activeName?s.activeName:(s.activeKey?s.activeKey:'-'))+' · '+reasonText(activeAcc));
    setDot('loopDot',true);setDot('loopDot2',true);
    $('accountsWrap').innerHTML=s.accounts.map(a=>accCard(a,s.activeKey)).join('');
    if(s.lastRoute){
      const lr=s.lastRoute;
      const lacc=(lr.accounts||[]).find(a=>a.key===lr.activeKey);
      $('lastRoute').textContent=JSON.stringify({active:lr.activeKey,reason:reasonText(lacc),accounts:(lr.accounts||[]).map(x=>({key:x.key,credits:x.credits?.total}))},null,2);
    }
  }catch(e){}
}
async function doLogin(key,region){
  try{
    const rl=region==='cn'?regionLabel('cn'):regionLabel('ai');
    alert(t('loginOpening',{k:key,r:rl}));
    const r=await fetch('/api/login/'+key+'?region='+region,{method:'POST'});
    const o=await r.json();
    alert(o.ok?(o.loggedIn?t('loginOk',{k:key}):t('loginNoFinish')):t('loginFail',{msg:o.reason||''}));
    await refresh();
  }catch(e){alert('登录请求失败：'+e.message)}
}
let addKey=null;
function showAddPick(key){
  addKey=key;
  $('addRegionTitle').textContent=t('addPick',{k:key});
  $('addRegionPick').style.display='block';
  applyI18n();
}
function hideAddPick(){$('addRegionPick').style.display='none';addKey=null}
async function doAddLogin(region){
  if(!addKey)return;
  const k=addKey;
  hideAddPick();
  await doLogin(k,region);
}
$('btnAdd').onclick=async()=>{
  try{
    const s=await j('/api/accounts');
    const nk=nextKey(s.accounts.map(a=>a.key));
    if(!nk){alert(t('addNoMore'));return}
    showAddPick(nk);
  }catch(e){alert('失败：'+e.message)}
};
$('btnAddInt').onclick=()=>doAddLogin('ai');
$('btnAddCn').onclick=()=>doAddLogin('cn');
$('btnAddCancel').onclick=hideAddPick;
$('btnRoute').onclick=async()=>{try{await fetch('/api/route',{method:'POST'});await refresh()}catch{}}

// ===== 认证信息 导入 / 导出 =====
function b64enc(s){return btoa(unescape(encodeURIComponent(s)))}
function b64dec(s){return decodeURIComponent(escape(atob(s)))}
async function copyTextToClipboard(s){
  try{await navigator.clipboard.writeText(s);return true}
  catch{
    // 兜底：textarea 复制
    const ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();
    let ok=false;try{ok=document.execCommand('copy')}catch{}
    document.body.removeChild(ta);return ok;
  }
}
async function copyAuthOne(key){
  try{
    const r=await fetch('/api/export?keys='+encodeURIComponent(key));
    const o=await r.json();
    if(!o.ok||!o.bundle?.accounts?.[key]){alert(t('authNoWeb'));return}
    const ok=await copyTextToClipboard(o.base64);
    alert(ok?t('authExportedN',{n:1}):'复制失败，请手动选择文本复制');
  }catch(e){alert('导出失败：'+e.message)}
}
// ===== 点击复制：Base URL / API Key =====
function flashCopied(btn){
  const orig=btn.textContent;
  btn.textContent='已复制 ✓';
  btn.classList.add('copied');
  setTimeout(()=>{btn.textContent=orig;btn.classList.remove('copied')},1500);
}
async function copyText(s,btn){
  try{
    await navigator.clipboard.writeText(s);
    flashCopied(btn);
  }catch{
    // 兜底：textarea 复制
    const ta=document.createElement('textarea');ta.value=s;document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');flashCopied(btn)}catch{alert('复制失败，请手动选择文本复制')}
    document.body.removeChild(ta);
  }
}
$('copyBaseUrl').onclick=()=>copyText($('baseUrl').textContent,$('copyBaseUrl'));
$('copyApiToken').onclick=()=>copyText($('apiToken').textContent,$('copyApiToken'));

// ===== API Key 生成 / 删除 =====
$('genToken').onclick=async()=>{
  try{
    const r=await fetch('/api/token/regenerate',{method:'POST'});
    const o=await r.json();
    alert(t('keyGen'));
    await refresh();
  }catch(e){alert('生成失败：'+e.message)}
};
$('delToken').onclick=async()=>{
  if(!confirm('删除 API Key 后，已配置该 Key 的客户端将无法调用，需重新生成。继续？'))return;
  try{
    const r=await fetch('/api/token/delete',{method:'POST'});
    const o=await r.json();
    alert(t('keyDel'));
    await refresh();
  }catch(e){alert('删除失败：'+e.message)}
};

$('btnExportAll').onclick=async()=>{
  try{
    const r=await fetch('/api/export?all=1');
    const o=await r.json();
    const n=o.bundle?Object.keys(o.bundle.accounts||{}).length:0;
    if(n===0){alert(t('authNoWeb'));return}
    const ok=await copyTextToClipboard(o.base64);
    alert(ok?t('authExportedN',{n:n}):'复制失败，可用「下载为文件」保存');
  }catch(e){alert('导出失败：'+e.message)}
};
$('btnDownload').onclick=async()=>{
  try{
    const r=await fetch('/api/export?all=1&download=1');
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='workbuddy-auth-export.json';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  }catch(e){alert('下载失败：'+e.message)}
};
$('btnImport').onclick=async()=>{
  const val=$('importArea').value;
  if(!val||!val.trim()){alert(t('authPasteLabel'));return}
  try{
    const r=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bundle:val})});
    const o=await r.json();
    if(o.ok){
      const list=(o.imported||[]).map(x=>x.key+'('+x.region+','+x.cookies+'c)').join('、');
      alert(t('authImportedOk',{list:list||'0'}));
      $('importArea').value='';
      await refresh();
    }else{
      alert(t('authImportFail',{msg:o.reason||JSON.stringify(o)}));
    }
  }catch(e){alert('导入失败：'+e.message)}
};
applyI18n();refresh();setInterval(refresh,15000);
</script></body></html>`;
}

// ============ Daemon: re-route every 30 min ============
function startDaemon() {
  const intervalMin = 30;
  const tick = async () => { try { await route(); } catch (e) { log('tick fail:', e.message); } };
  setInterval(() => tick().catch(() => {}), intervalMin * 60 * 1000);
  log('[daemon] started, route every ' + intervalMin + ' min');
}

function writeEndpoint() {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  fs.writeFileSync(EP_FILE, JSON.stringify({ host: HOST, port: PORT, token: TOKEN || '', baseUrl: `http://${HOST}:${PORT}/v1`, startedAt: new Date().toISOString() }, null, 2));
}

function ensurePlaywright() {
  const pkg = path.join(__dirname, 'node_modules', 'playwright', 'package.json');
  if (fs.existsSync(pkg)) return { ok: true, reason: 'playwright present' };
  log('[deps] playwright missing, trying npm install ...');
  try {
    execSync('npm install --no-audit --no-fund', { cwd: __dirname, stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd.exe' : false, timeout: 180000 });
  } catch (e) {
    log('[deps] npm install failed:', e.message);
    return { ok: false, reason: e.message.slice(0, 200) };
  }
  if (fs.existsSync(pkg)) return { ok: true, reason: 'playwright installed' };
  return { ok: false, reason: 'playwright still missing after npm install' };
}

async function main() {
  log('=== WorkBuddy multi-account bridge webapp starting (portable) ===');
  log('DSH_HOME=' + DSH_HOME + ' | plugin=' + PLUGIN_MAIN);
  log('plugin file exists: ' + fs.existsSync(PLUGIN_MAIN));
  log('WorkBuddy AI desktop: ' + (AI_ELECTRON.bin || 'MISSING') + ' source=' + AI_ELECTRON.source);
  log('WorkBuddy CN desktop: ' + (CN_ELECTRON.bin || 'MISSING') + ' source=' + CN_ELECTRON.source);
  log('MIRROR_DIR=' + MIRROR_DIR + ' | port=' + PORT);
  const pw = ensurePlaywright();
  log('[deps] ' + pw.reason);
  writeEndpoint();
  log('token=' + TOKEN.slice(0, 8) + '...');
  await route();

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== HOST && host !== 'localhost') { res.writeHead(403); res.end('loopback only'); return; }
    const clean = (req.url || '').split('?')[0];
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');

    if (req.method === 'GET' && (clean === '/' || clean === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(uiPage());
      return;
    }

    if (req.method === 'GET' && clean === '/api/accounts') {
      const A = await accountA(); A.key = 'A';
      const webs = await Promise.all(webAccountKeys().map(k => accountWeb(k)));
      let lastRoute = null;
      try { lastRoute = JSON.parse(fs.readFileSync(ROUTE_FILE, 'utf8')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ loopback: { baseUrl: `http://${HOST}:${PORT}/v1`, token: TOKEN, upstream: upstreamDomainOf(lastRoute?.activeKey ? (lastRoute.accounts||[]).find(a=>a.key===lastRoute.activeKey) : null) }, activeKey: lastRoute?.activeKey, activeName: lastRoute?.activeName, reason: lastRoute?.reason, accounts: [A, ...webs], lastRoute }));
      return;
    }

    if (req.method === 'POST' && clean === '/api/route') {
      const d = await route();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(d));
      return;
    }

    // ===== API Key 管理：生成（新 Key）/ 删除（清空） =====
    if (req.method === 'POST' && clean === '/api/token/regenerate') {
      TOKEN = crypto.randomBytes(24).toString('hex');
      writeStoredToken(TOKEN);
      writeEndpoint();
      log('[token] regenerated API key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: TOKEN }));
      return;
    }
    if (req.method === 'POST' && clean === '/api/token/delete') {
      TOKEN = '';
      writeStoredToken('');
      writeEndpoint();
      log('[token] API key deleted (cleared)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, token: '' }));
      return;
    }

    if (req.method === 'POST' && clean.startsWith('/api/login/')) {
      const key = clean.replace('/api/login/', '').toUpperCase();
      if (!/^[A-Z]$/.test(key) || key === 'A') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'only web accounts B/C/D/... ; A is desktop' })); return; }
      const region = query.get('region') === 'cn' ? 'cn' : 'ai';
      const r = await loginWeb(key, region);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
      return;
    }

    // 导出认证信息：?keys=B,C 或 ?all=1（全部网页账号）
    if (req.method === 'GET' && clean === '/api/export') {
      const keysAll = query.get('all') === '1';
      const keysParam = query.get('keys') || '';
      let keys;
      if (keysAll) keys = []; // 空数组 => exportBundle 内走 webAccountKeys()
      else keys = keysParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
      const bundle = exportBundle(keys);
      const out = query.get('fmt') === 'json' ? JSON.stringify(bundle, null, 2) : bundle;
      if (query.get('download') === '1') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="workbuddy-auth-export.json"' });
        res.end(JSON.stringify(bundle, null, 2));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, bundle, base64: Buffer.from(JSON.stringify(bundle)).toString('base64') }));
      }
      return;
    }

    // 导入认证信息：POST { bundle: "<json 或 base64>" }
    if (req.method === 'POST' && clean === '/api/import') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = { bundle: Buffer.concat(chunks).toString('utf8') }; }
        const r = importBundle(body.bundle ?? body);
        let reRoute = null;
        if (r.ok) reRoute = await route().catch(e => ({ error: e.message }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...r, reRoute: reRoute ? { activeKey: reRoute.activeKey, reason: reRoute.reason } : null }));
      });
      return;
    }

    if (req.method === 'GET' && (clean === '/v1/models' || clean === '/v1/models/')) {
      const auth = req.headers.authorization || '';
      if (!TOKEN || auth !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: TOKEN ? 'unauthorized' : 'API key not set - generate one in the UI', type: 'auth' } })); return; }
      const lastRoute = JSON.parse(fs.existsSync(ROUTE_FILE) ? fs.readFileSync(ROUTE_FILE, 'utf8') : '{}');
      const activeKey = lastRoute.activeKey || 'A';
      try {
        let models;
        if (activeKey === 'A') {
          const plugin = await loadPlugin();
          const store = new plugin.WorkBuddyCredentialStore({ variant: plugin.AI_VARIANT });
          const st = await store.status();
          if (st.state !== 'signed-in') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'A signed out', type: 'auth' } })); return; }
          const cred = await store.current();
          const client = new plugin.WorkBuddyUpstreamClient({ variant: plugin.AI_VARIANT });
          models = await client.fetchModels(cred);
        } else {
          const meta = readMeta();
          const acc = meta[activeKey];
          if (!acc?.cookieFile) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: activeKey + ' not logged in', type: 'auth' } })); return; }
          const domain = acc.region === 'cn' ? 'www.workbuddy.cn' : 'www.workbuddy.ai';
          const cookies = JSON.parse(fs.readFileSync(acc.cookieFile, 'utf8'));
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          const r = await fetch(`https://${domain}/v3/config`, {
            headers: { Cookie: cookieStr, 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Origin': `https://${domain}`, 'Referer': `https://${domain}/` },
            signal: AbortSignal.timeout(20000)
          });
          const j = await r.json().catch(() => null);
          models = j?.data?.models || j?.models || [];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', owned_by: 'workbuddy', free: m.billing?.free === true, credits: m.billing?.credits })) }));
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message.slice(0, 300), type: 'upstream' } }));
      }
      return;
    }
    if (req.method === 'POST' && clean === '/v1/chat/completions') {
      const auth = req.headers.authorization || '';
      if (!TOKEN || auth !== `Bearer ${TOKEN}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: TOKEN ? 'unauthorized' : 'API key not set - generate one in the UI', type: 'auth' } })); return; }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const plugin = await loadPlugin();
          const store = new plugin.WorkBuddyCredentialStore({ variant: plugin.AI_VARIANT });
          const st = await store.status();
          if (st.state !== 'signed-in') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'A signed out', type: 'auth' } })); return; }
          const cred = await store.current();
          const client = new plugin.WorkBuddyUpstreamClient({ variant: plugin.AI_VARIANT });
          const raw = Buffer.concat(chunks).toString('utf8');
          const prepared = plugin.prepareInternationalChatBody(raw);
          const controller = new AbortController();
          req.on('close', () => controller.abort());
          const result = await client.chatStream(cred, prepared, controller.signal);
          if (!result.ok) {
            res.writeHead(result.status || 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `upstream ${result.kind}`, type: 'upstream' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          for await (const chunk of result.response.body) res.write(chunk);
          res.end();
        } catch (e) {
          log('chat error:', e.message);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message.slice(0, 300), type: 'internal' } }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'not_found' } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      log(`=== webapp listening at http://${HOST}:${PORT} ===`);
      resolve();
    });
  });

  try {
    spawn('start', [`http://${HOST}:${PORT}/`], { shell: true, stdio: 'ignore' });
    log('[auto-open browser] http://' + HOST + ':' + PORT + '/');
  } catch {}


  startDaemon();
  log('[webapp] running; close window or Ctrl-C to stop');
}

process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e?.message || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e?.message || e); });

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
