# WorkBuddy 多账号桥接（WorkBuddy Multi-Account Bridge）

双击启动的 WorkBuddy 多账号管理工具：本地 Web UI（中文/英文）+ 自动路由 + 可移植部署。

## 功能

- **多账号**：账号 A（桌面客户端）+ 账号 B/C/D...（网页登录，支持国际版 `.ai` 与国内版 `.cn`）
- **自动路由**：按积分余额自动选择主账号，耗尽时自动切换，每 30 分钟重新评估
- **OpenAI 兼容端点**：本地回环 `127.0.0.1:3085` 提供 `/v1/models`、`/v1/chat/completions`
- **认证信息导入/导出**：网页账号的 cookie 可跨机器搬运（外网登录 → 导出 → 内网/重装后导入）
- **可移植**：`portable-config.txt` 记录本机路径，拷到其它电脑改一下就能跑
- **UI 国际化**：中文默认，英文可选

## 快速开始

1. 安装 Node.js LTS
2. 双击 `start-bridge.bat`（Windows）
   - 首次运行会自动安装 `playwright` 依赖
   - 浏览器自动打开 `http://127.0.0.1:3085/`
3. 在 UI 里登录网页账号（B/C/D...），或从外网导入已导出的认证信息
4. 桌面账号 A 需要本机装有 WorkBuddy / WorkBuddyAI 客户端 + DSH web profile 的 `dsh-workbuddy-connect` 插件

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `wb-webapp.js` | 主程序（UI + 路由 + 回环代理 + i18n + 认证导入导出） |
| `run-bridge.cjs` | 可移植启动器：读 `portable-config.txt`、自动装依赖、起服务 |
| `start-bridge.bat` | 双击入口：找 Node → 调 `run-bridge.cjs` |
| `check-port.cjs` | 端口占用探测 |
| `load-portable-config.cjs` | 配置解析辅助 |
| `make-portable-config.mjs` | 单独生成 `portable-config.txt` 的脚本（备用） |
| `verify-webapp.js` | 自检脚本（起服务后跑一遍 `/api/accounts`、`/v1/*`） |
| `portable-config.txt.example` | 配置模板（拷成 `portable-config.txt` 填本机路径） |
| `package.json` | 依赖声明（`playwright`） |

## 可移植配置

`portable-config.txt` 支持以下键（也支持同名环境变量覆盖）：

```text
WORKBUDDY_AI_ELECTRON_BIN=   # WorkBuddyAI.exe（国际版桌面）
WORKBUDDY_ELECTRON_BIN=      # WorkBuddy.exe（国内版桌面）
DSH_HOME=~/.dsh              # DSH 配置目录（账号 A 依赖）
WORKBUDDY_MIRROR_DIR=~/.workbuddy-mirror  # 镜像目录（cookie、路由状态）
WORKBUDDY_PLUGIN_MAIN=       # 可选：dsh-workbuddy-connect 插件 lib/index.js 绝对路径
WB_PORT=3085                 # Web UI / 回环代理端口
```

- `~` 展开为当前用户主目录
- 拷到新电脑后，先双击 `start-bridge.bat` 一次，它会自动探测本机路径并回填 `portable-config.txt`
- 只需用网页账号（B/C/D...）时，不需要 WorkBuddy 桌面客户端和 DSH，cookie 通过 UI 导入即可

## 认证信息搬运

UI 的「认证信息 导入/导出」卡片：

- **导出**：复制全部/单个网页账号的 cookie bundle（base64 或 JSON）
- **导入**：粘贴导出内容，自动写回 cookie 文件并重新路由

桌面账号 A 的凭据是本机加密的，无法跨机器；重装后需用桌面客户端重新登录。

## 运行环境

- Windows（测试环境）；其它系统需自行适配 `start-bridge.bat` 的 Node 探测
- Node.js LTS（≥ 18）
- 桌面账号 A 需要：WorkBuddy / WorkBuddyAI 客户端 + DSH web profile 的 `dsh-workbuddy-connect` 插件

## 许可证

MIT
