// 快速探测端口是否被占用。输出 "True"（占用）或 "False"（空闲）。
// 端口优先级：环境变量 WB_PORT > 同目录 portable-config.txt 里的 WB_PORT > 3085。
const fs = require('fs');
const path = require('path');
const os = require('os');

function readConfigPort() {
  try {
    const cfgFile = path.join(__dirname, 'portable-config.txt');
    for (const line of fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*WB_PORT\s*=\s*(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
    }
  } catch {}
  return null;
}
const PORT = parseInt(process.env.WB_PORT || String(readConfigPort() || '3085'), 10);

const net = require('net');
const s = net.createServer();
s.once('error', () => { process.stdout.write('True'); s.close(); process.exit(0); });
s.once('listening', () => { s.close(() => { process.stdout.write('False'); process.exit(0); }); });
s.listen(PORT, '127.0.0.1');
setTimeout(() => { try { s.close(); } catch {} process.stdout.write('False'); process.exit(0); }, 2000);
