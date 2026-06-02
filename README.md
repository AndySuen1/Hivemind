# Hivemind

通过 Discord 远程指挥本机 Claude Code 干活，多 bot / 多 LLM 协作平台。

## 快速开始

```bash
# 1. 装依赖（首次）
pnpm install

# 2. 配置环境变量
cp .env.example apps/orchestrator/.env
# 编辑 apps/orchestrator/.env 填入 DISCORD_BOT_TOKEN / DEEPSEEK_API_KEY / ALLOWED_USER_IDS

# 3. 跑起来
pnpm dev
```

启动后在 Discord DM 这个 bot 任意消息，应该收到 DeepSeek 的回复。

## 桌面托盘启动器（一键启动 + 托盘）

`apps/launcher` 是 Electron 托盘启动器：一条命令启动后驻留系统托盘，自动拉起 orchestrator + dashboard。

```bash
pnpm dev:launcher
```

托盘菜单：打开管理网站 / 启动·停止·重启服务 / 开机自启 / 退出。管理网站「系统设置」页可改端口、开机自启、导出/导入配置。细节见 [apps/launcher/README.md](apps/launcher/README.md)。

## 在新机器上运行（clone 后继续开发 / 使用）

前提：**Node ≥ 20、pnpm、git**。

```bash
git clone <你的仓库地址>
cd hivemind
pnpm install        # 重新下载 electron + 就地重编原生模块（better-sqlite3 / keytar）
pnpm dev:launcher   # 或 pnpm dev（不带托盘，仅两个服务）
```

- **electron 下载慢 / 断**（国内常见）：用镜像重试
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node apps/launcher/node_modules/electron/install.js`
- **密钥与 bot 配置不随仓库走（按设计）**：
  - API key / Discord token 存系统凭证库（keytar）；bots / providers 存**被 git 忽略**的 `data/app.db`。
  - 迁移：旧机器在 dashboard「系统设置 → 配置迁移」勾「包含密钥」**导出 JSON**，新机器**导入**即可；或在新机器重新添加 Provider / Bot。
  - ⚠️ 含密钥的导出文件请勿提交到 git 或外发。
- **跨平台**：Windows / macOS 均可（Electron 跨平台；原生模块 `pnpm install` 自动按本机重编）。
  - 开机自启：Win / macOS 的 dev 形态都已支持（分别写注册表 Run / `~/Library/LaunchAgents` plist，指向「系统 node 跑 `scripts/dev.mjs`」）。
  - macOS 若用未签名打包 app，首次需在「系统设置 → 隐私与安全性」放行；dev 形态 `pnpm dev:launcher` 无此问题。

> **推 GitHub 安全**：密钥在 keytar，`.env` 与 `data/*.db` 已被 `.gitignore` 忽略，仓库不含任何密钥 / token。

## 目录

```
hivemind/
├── apps/
│   ├── orchestrator/   # Fastify 后端(:3001) — Discord bots + 工具 + Claude 委派 + 可观测埋点
│   ├── dashboard/      # Next.js 管理网站(:3000) — Providers / Bots / 可观测 / 系统设置
│   └── launcher/       # Electron 托盘启动器 — 一键启动 + 进程管家 + 本地控制 API
├── packages/
│   └── shared/         # 跨包 TS 类型与 Zod schema
└── data/               # SQLite（app.db，已被 .gitignore 忽略）
```

## 进度

**已完成**
- [x] Phase -1：版本检查、目录、确认未设 ANTHROPIC_API_KEY
- [x] Phase 0：单 DeepSeek bot 对话 MVP
- [x] Phase 1：fs / bash / memory 工具 + 多步 tool-calling 循环
- [x] Phase 1.5：Web Search（多源自动兜底：DuckDuckGo / Tavily / Brave / SearXNG）
- [x] Phase 2：delegate_to_claude —— DeepSeek 主脑按需委派 Claude Code 子进程，危险操作经 Discord 审批
- [x] Phase 3（基础）：多 bot + SQLite + keytar 密钥存储
- [x] Phase 4：Dashboard（Next.js）—— Providers / Bots / 系统设置
- [x] 可观测性：聊天 / 执行追踪 / 记忆浏览 / Live 总览（SSE 实时）+ 历史清理与保留策略
- [x] 桌面托盘启动器（Electron）—— 一键启动、托盘、端口/开机自启、配置导出导入
- [x] 重命名为 Hivemind
- [x] 对话记忆四层：重启复原 / 滚动摘要 / FTS5 检索 / 触发式固化整理
- [x] Phase 3：Inter-Agent（bot 之间 @ 协作）—— 把员工 bot 编进**项目**（同项目自动可互相 @，免配白名单）；`mention_bot` 在频道里真实 @ 同项目同伴接力（异步即发即走）；Inter-Agent Router 管控转交跳数 / 累计成本 / 短循环（A→B→A→B）检测 / 全局日成本熔断（预算挂在项目上），受阻则暂停并 @ 发起人给「继续 / 终止」按钮

**待办**
- [ ] Phase 3.5：Skill 系统 + 调度器
- [ ] Phase 4.5：RAG（可选）
- [ ] Phase 5：免环境一键打包（standalone + 随包 Node + 代码签名）+ 上线
