# @discord-agent-hub/launcher

桌面托盘启动器（Electron 壳）。一键启动后驻留系统托盘，负责拉起 orchestrator 与 dashboard，
并提供「打开管理网站 / 启停服务 / 开机自启 / 退出」。现支持 Windows，架构为将来移植 macOS 预留。

## 设计要点

- **服务以独立系统 Node 子进程 spawn**（`process-manager.ts`），主进程不加载任何原生模块。
  因此 `better-sqlite3` / `keytar` 沿用系统 Node ABI，**永远不需要 electron-rebuild**。
  纪律：**绝不**用 Electron 的 `fork` / `UtilityProcess`（它们 `ELECTRON_RUN_AS_NODE=1` 仍跑 Electron ABI）。
- **配置单一事实源** = `userData/launcher.json`（端口、开机自启、token 等）。端口是 spawn 服务的前置输入，
  故不放进 orchestrator 的 SQLite。
- **本地控制 API**（`127.0.0.1:<controlPort>` + token），dashboard 的 `/settings` 页直连它读写设置、启停服务。
- 改端口 → 写配置 → 用新 `API_PORT` / `-p` / `DASHBOARD_ORIGIN` env 重启子进程。
- **开机自启**（`login-item.ts`）分两条路径：
  - **dev（未打包）+ Windows**：直接管理 `HKCU\...\Run` 注册表项（值名 `DiscordAgentHubLauncher`），
    命令 = `"<系统node>" "<…/scripts/dev.mjs>"`。因为 dev 下 `process.execPath` 是 node_modules 里的 `electron.exe`，
    裸 `openAtLogin` 注册它开机只会弹空白 Electron；而 `dev.mjs` 会清掉 `ELECTRON_RUN_AS_NODE` 并以绝对路径拉起 Electron 应用。
    （Electron 的 `getLoginItemSettings` 在 Windows + 自定义 args 下回读不可靠，故直接读注册表为 ground truth。）
  - **打包（v2）或 macOS**：`execPath` 即真应用，直接 `app.setLoginItemSettings({openAtLogin})`。

## 开发运行

前提：仓库根已 `pnpm install`（含本 app 的 electron），且 orchestrator/dashboard 依赖已装。

```bash
# 在仓库根
pnpm dev:launcher
# 或在本目录
pnpm dev          # tsc 编译主进程 + 经 scripts/dev.mjs 启动 electron
```

> `scripts/dev.mjs` 会在启动 Electron 前清掉环境里的 `ELECTRON_RUN_AS_NODE`。
> 某些环境（如被 Claude Code / Agent SDK 注入）会全局设 `ELECTRON_RUN_AS_NODE=1`，
> 否则 electron 会以纯 Node 模式运行、`require('electron').app` 为 `undefined` 而崩溃。

首次安装若 electron 二进制下载失败（GitHub 慢/断），用镜像重试：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

## 托盘菜单

打开管理网站（系统默认浏览器）/ 启动·停止·重启服务 / 开机自启（勾选）/ 退出。

## 配置文件

`userData/launcher.json`（Windows: `%APPDATA%\discord-agent-hub-launcher\launcher.json`）：

| 字段 | 说明 | 默认 |
|---|---|---|
| `apiPort` | orchestrator API 端口（注入 `API_PORT`） | 3001 |
| `dashboardPort` | dashboard 端口（`next -p`） | 3000 |
| `host` | 服务主机 | 127.0.0.1 |
| `controlPort` | 本地控制 API 端口 | 8787 |
| `autoStartService` | 启动器打开后自动拉起服务 | true |
| `openLoginItem` | 期望开机自启（实际以 OS 回读为准） | false |
| `controlToken` | 控制 API 本地 token（自动生成） | 随机 |
| `nodePath` | 可选：手动指定系统 node 可执行文件 | 自动探测 |

## 控制 API

需请求头 `X-Launcher-Token: <controlToken>`；仅回环来源（CORS）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/launcher/settings` | 取设置 + 状态 |
| PUT | `/launcher/settings` | 改端口/自启等，必要时重启服务 |
| GET | `/launcher/service/status` | 取服务状态 |
| POST | `/launcher/service/{start,stop,restart}` | 启停/重启服务 |

## 打包（v2，未实现）

`pnpm pack`（electron-builder，需先补 `electron-builder.yml` 与 electron-builder 依赖）。
真正免环境一键包还需：Next standalone + `API_BASE` 运行期化 + 随包 Node runtime + 原生模块随包编译 + 代码签名。
详见仓库计划文件。
